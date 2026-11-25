import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";

const BASE = "https://intervals.icu/api/v1";

function maxRollingAvg(watts: number[], startIdx: number, windowSec: number): number | null {
  if (watts.length - startIdx < windowSec) return null;
  let sum = 0;
  for (let i = startIdx; i < startIdx + windowSec; i++) {
    sum += watts[i] || 0;
  }
  let maxSum = sum;
  for (let i = startIdx + windowSec; i < watts.length; i++) {
    sum += (watts[i] || 0) - (watts[i - windowSec] || 0);
    if (sum > maxSum) maxSum = sum;
  }
  return Math.round((maxSum / windowSec) * 10) / 10;
}

export class MyMCP extends McpAgent {
  server = new McpServer({ name: "Intervals.icu", version: "1.3.0" });

  private authHeader() {
    return `Basic ${btoa(`API_KEY:${this.env.INTERVALS_API_KEY}`)}`;
  }

  private async icu(path: string, init: RequestInit = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: this.authHeader(), "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`intervals.icu ${res.status}: ${await res.text()}`);
    const text = await res.text();
    if (!text) return { ok: true };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true, raw: text };
    }
  }

  async init() {
    const athlete = this.env.INTERVALS_ATHLETE_ID;

    this.server.tool(
      "getActivities",
      {
        days: z.number().optional().describe("Days back if oldest is not provided, default 30"),
        oldest: z.string().optional().describe("Start date YYYY-MM-DD (overrides days)"),
        newest: z.string().optional().describe("End date YYYY-MM-DD (defaults to today)"),
      },
      async ({ days = 30, oldest, newest }) => {
        const start = oldest ?? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const query = newest ? `oldest=${start}&newest=${newest}` : `oldest=${start}`;
        const data = await this.icu(`/athlete/${athlete}/activities?${query}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "getActivityDetails",
      {
        activityId: z.string().describe("Activity ID (e.g. 'i12345678') from getActivities"),
        includeIntervals: z.boolean().optional().describe("Include laps and detected intervals, default true"),
      },
      async ({ activityId, includeIntervals = true }) => {
        const data = await this.icu(`/activity/${activityId}?intervals=${includeIntervals}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "getActivityStreams",
      {
        activityId: z.string().describe("Activity ID (e.g. 'i12345678')"),
        types: z.string().optional().describe("Comma-separated streams: watts,heartrate,cadence,altitude,velocity_smooth,distance,time,w_bal. Default 'watts,heartrate,cadence,altitude,distance'"),
        startSec: z.number().optional().describe("Start second of slice (e.g. 3600 for 1h into ride). Omit for full ride."),
        endSec: z.number().optional().describe("End second of slice (e.g. 4500). Omit for full ride."),
        sampleRate: z.number().optional().describe("Keep 1 point every N seconds (default 1 if slice <= 1800s, else 5 to avoid token overflow)"),
      },
      async ({
        activityId,
        types = "watts,heartrate,cadence,altitude,distance",
        startSec,
        endSec,
        sampleRate,
      }) => {
        const streamTypes = types.split(",").map((t) => t.trim()).filter(Boolean);
        const query = streamTypes.map((t) => `types=${encodeURIComponent(t)}`).join("&");
        const rawStreams: Array<{ type: string; data: number[] }> = await this.icu(
          `/activity/${activityId}/streams.json?${query}`,
        );

        const totalLen = rawStreams[0]?.data?.length ?? 0;
        const from = Math.max(0, startSec ?? 0);
        const to = Math.min(totalLen, endSec ?? totalLen);
        const sliceLen = Math.max(0, to - from);
        const step = Math.max(1, sampleRate ?? (sliceLen <= 1800 ? 1 : 5));

        const result: Record<string, unknown> = {
          activityId,
          totalDurationSec: totalLen,
          returnedRangeSec: [from, to],
          sampleRateSec: step,
          streams: {} as Record<string, number[]>,
        };

        for (const s of rawStreams) {
          const sampled: number[] = [];
          for (let i = from; i < to; i += step) {
            sampled.push(s.data[i]);
          }
          (result.streams as Record<string, number[]>)[s.type] = sampled;
        }

        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    );

    this.server.tool(
      "getFatiguedPower",
      {
        activityIds: z.string().describe("One or more comma-separated Activity IDs (e.g. 'i12345,i67890')"),
        afterKj: z.number().optional().describe("Minimum accumulated work in kJ (e.g. 1000, 1500, 2000)"),
        afterKjPerKg: z.number().optional().describe("Alternative: minimum accumulated work in kJ/kg (e.g. 15, 25, 30)"),
      },
      async ({ activityIds, afterKj, afterKjPerKg }) => {
        const ids = activityIds.split(",").map((s) => s.trim()).filter(Boolean);
        let thresholdKj = afterKj ?? 0;

        if (afterKjPerKg !== undefined && afterKj === undefined) {
          const profile = await this.icu(`/athlete/${athlete}`);
          const weight = profile.icu_weight || profile.weight || 75;
          thresholdKj = afterKjPerKg * weight;
        }

        const durations = [
          { label: "5s", sec: 5 },
          { label: "15s", sec: 15 },
          { label: "30s", sec: 30 },
          { label: "1m", sec: 60 },
          { label: "2m", sec: 120 },
          { label: "3m", sec: 180 },
          { label: "5m", sec: 300 },
          { label: "8m", sec: 480 },
          { label: "10m", sec: 600 },
          { label: "12m", sec: 720 },
          { label: "20m", sec: 1200 },
          { label: "30m", sec: 1800 },
          { label: "60m", sec: 3600 },
        ];

        const perActivity: any[] = [];
        const aggregateBest: Record<string, { watts: number; activityId: string; name: string; date: string }> = {};

        for (const id of ids) {
          const [details, streams] = await Promise.all([
            this.icu(`/activity/${id}?intervals=false`),
            this.icu(`/activity/${id}/streams.json?types=watts,time`) as Promise<Array<{ type: string; data: number[] }>>,
          ]);

          const wattsStream = streams.find((s) => s.type === "watts")?.data;
          const timeStream = streams.find((s) => s.type === "time")?.data;

          if (!wattsStream || wattsStream.length === 0) {
            perActivity.push({ activityId: id, name: details.name, error: "No power stream available" });
            continue;
          }

          let cumKj = 0;
          let thresholdIdx = thresholdKj <= 0 ? 0 : -1;

          for (let i = 0; i < wattsStream.length; i++) {
            const dt = i === 0 ? 1 : Math.max(1, (timeStream?.[i] ?? i) - (timeStream?.[i - 1] ?? (i - 1)));
            cumKj += ((wattsStream[i] || 0) * dt) / 1000;
            if (thresholdIdx === -1 && cumKj >= thresholdKj) {
              thresholdIdx = i;
            }
          }

          if (thresholdIdx === -1) {
            perActivity.push({
              activityId: id,
              name: details.name,
              date: details.start_date_local?.slice(0, 10),
              totalKj: Math.round(cumKj),
              note: `Threshold ${Math.round(thresholdKj)} kJ not reached`,
            });
            continue;
          }

          const peaksAfterThreshold: Record<string, number | null> = {};
          const freshPeaks: Record<string, number | null> = {};

          for (const d of durations) {
            const fatiguedW = maxRollingAvg(wattsStream, thresholdIdx, d.sec);
            const freshW = maxRollingAvg(wattsStream, 0, d.sec);
            peaksAfterThreshold[d.label] = fatiguedW;
            freshPeaks[d.label] = freshW;

            if (fatiguedW !== null) {
              if (!aggregateBest[d.label] || fatiguedW > aggregateBest[d.label].watts) {
                aggregateBest[d.label] = {
                  watts: fatiguedW,
                  activityId: id,
                  name: details.name,
                  date: details.start_date_local?.slice(0, 10),
                };
              }
            }
          }

          perActivity.push({
            activityId: id,
            name: details.name,
            date: details.start_date_local?.slice(0, 10),
            totalKj: Math.round(cumKj),
            thresholdReachedAtSec: timeStream?.[thresholdIdx] ?? thresholdIdx,
            peaksAfterThreshold,
            freshPeaksInSameRide: freshPeaks,
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                thresholdKj: Math.round(thresholdKj),
                aggregateBestAcrossRides: aggregateBest,
                activities: perActivity,
              }),
            },
          ],
        };
      },
    );

    this.server.tool(
      "getPowerCurve",
      {
        curves: z.string().optional().describe("Fresh power curve period: e.g. '42d', '90d', '1y', 'all'. Default '90d'"),
        type: z.string().optional().describe("Sport type, default 'Ride'"),
      },
      async ({ curves = "90d", type = "Ride" }) => {
        const data = await this.icu(`/athlete/${athlete}/power-curves.json?curves=${encodeURIComponent(curves)}&type=${encodeURIComponent(type)}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "getAthleteProfile",
      {},
      async () => {
        const data = await this.icu(`/athlete/${athlete}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "getWellness",
      { days: z.number().optional().describe("Days back, default 14") },
      async ({ days = 14 }) => {
        const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/wellness?oldest=${oldest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "listUpcomingEvents",
      { days: z.number().optional().describe("Days ahead, default 14") },
      async ({ days = 14 }) => {
        const today = new Date().toISOString().slice(0, 10);
        const newest = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/events?oldest=${today}&newest=${newest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "createWorkout",
      {
        date: z.string().describe("YYYY-MM-DD"),
        name: z.string(),
        type: z.string().describe("Run, Ride, Swim, etc."),
        description: z.string().describe("Structured steps, e.g. '- 10m Z2\\n- 6x800m Z4, 400m Z1 jog\\n- 10m Z2'"),
      },
      async ({ date, name, type, description }) => {
        const data = await this.icu(`/athlete/${athlete}/events`, {
          method: "POST",
          body: JSON.stringify({ start_date_local: `${date}T00:00:00`, category: "WORKOUT", type, name, description }),
        });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "updateWorkout",
      {
        eventId: z.number().describe("Event ID from listUpcomingEvents"),
        date: z.string().optional().describe("YYYY-MM-DD"),
        name: z.string().optional(),
        type: z.string().optional(),
        description: z.string().optional(),
      },
      async ({ eventId, date, name, type, description }) => {
        const body: Record<string, unknown> = {};
        if (date) body.start_date_local = `${date}T00:00:00`;
        if (name) body.name = name;
        if (type) body.type = type;
        if (description) body.description = description;
        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "deleteEvent",
      { eventId: z.number().describe("Event ID from listUpcomingEvents") },
      async ({ eventId }) => {
        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, { method: "DELETE" });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  }
}

function loginPage(state: string, error: string) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Intervals.icu MCP</title>
  <body style="font-family:system-ui;max-width:20rem;margin:4rem auto">
  <h2>Intervals.icu MCP</h2>
  <p style="color:#c00">${error}</p>
  <form method="post">
    <input type="hidden" name="state" value="${state}">
    <input type="password" name="password" placeholder="Password" autofocus
           style="width:100%;padding:.5rem;margin-bottom:.5rem">
    <button style="width:100%;padding:.5rem">Authorize</button>
  </form></body>`;
}

const defaultHandler = {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
    const html = { "content-type": "text/html;charset=utf-8" };

    if (request.method === "GET") {
      const info = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      return new Response(loginPage(btoa(JSON.stringify(info)), ""), { headers: html });
    }

    const body = await request.formData();
    const state = String(body.get("state") ?? "");
    if (String(body.get("password")) !== env.MCP_PASSWORD) {
      return new Response(loginPage(state, "Wrong password"), { status: 401, headers: html });
    }

    const info = JSON.parse(atob(state));
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: info,
      userId: "owner",
      metadata: {},
      scope: info.scope ?? [],
      props: {},
    });
    return Response.redirect(redirectTo, 302);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: MyMCP.serve("/mcp") as any,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
                                                                                        
