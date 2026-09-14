import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listUpcomingEvents, extractMeetLink, describeCalendarError } from "./calendar";

describe("describeCalendarError", () => {
  it("explains a disabled Calendar API (the common post-sign-in 403)", async () => {
    const res = new Response(
      JSON.stringify({ error: { message: "Google Calendar API has not been used in project 123 before or it is disabled." } }),
      { status: 403 },
    );
    const msg = await describeCalendarError(res);
    expect(msg).toMatch(/enable it in google cloud console/i);
    expect(msg).toMatch(/calendar api/i);
  });

  it("explains an insufficient-scope 403", async () => {
    const res = new Response(JSON.stringify({ error: { status: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" } }), {
      status: 403,
    });
    expect(await describeCalendarError(res)).toMatch(/sign in again/i);
  });

  it("falls back to the status code for other errors", async () => {
    const res = new Response("", { status: 500 });
    expect(await describeCalendarError(res)).toBe("Calendar API error: 500");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sampleItems = {
  items: [
    {
      id: "ev1",
      summary: "Standup",
      start: { dateTime: "2026-07-22T10:00:00Z" },
      end: { dateTime: "2026-07-22T10:15:00Z" },
      hangoutLink: "https://meet.google.com/abc-defg-hij",
    },
    {
      id: "ev2",
      summary: "Client call",
      start: { dateTime: "2026-07-22T15:00:00Z" },
      end: { dateTime: "2026-07-22T16:00:00Z" },
      location: "https://us02web.zoom.us/j/123456789?pwd=xyz",
    },
    {
      id: "ev3",
      start: { date: "2026-07-23" },
      end: { date: "2026-07-24" },
      description:
        'Join here: <a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0">Teams</a>',
    },
    {
      id: "ev4",
      summary: "Lunch",
      start: { dateTime: "2026-07-22T12:00:00Z" },
      end: { dateTime: "2026-07-22T13:00:00Z" },
      location: "Cafe downstairs",
    },
  ],
};

describe("listUpcomingEvents", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps API items to CalendarEvent (title, times, meet links)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sampleItems));

    const events = await listUpcomingEvents("tok-1");

    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({
      id: "ev1",
      title: "Standup",
      start: "2026-07-22T10:00:00Z",
      end: "2026-07-22T10:15:00Z",
      meetLink: "https://meet.google.com/abc-defg-hij",
    });
    // Zoom link from location
    expect(events[1].meetLink).toBe(
      "https://us02web.zoom.us/j/123456789?pwd=xyz",
    );
    // Teams link from description; all-day event uses date; untitled fallback
    expect(events[2].title).toBe("(untitled)");
    expect(events[2].start).toBe("2026-07-23");
    expect(events[2].meetLink).toBe(
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0",
    );
    // No link at all
    expect(events[3].meetLink).toBeUndefined();
  });

  it("sends auth header, maxResults, singleEvents, orderBy and timeMin", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await listUpcomingEvents("tok-abc", 7);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [urlStr, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(urlStr);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(url.searchParams.get("maxResults")).toBe("7");
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    expect(url.searchParams.get("timeMin")).toBeTruthy();
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-abc",
    );
  });

  it("defaults maxResults to 15", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await listUpcomingEvents("tok");

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("maxResults")).toBe("15");
  });

  it("on 401 refreshes via callback and retries once with the new token", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse(sampleItems));
    const onUnauthorized = vi.fn().mockResolvedValue("fresh-token");

    const events = await listUpcomingEvents("stale-token", 15, onUnauthorized);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer fresh-token",
    );
    expect(events).toHaveLength(4);
  });

  it("throws when retry after refresh still fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 401));
    const onUnauthorized = vi.fn().mockResolvedValue("still-bad");

    await expect(
      listUpcomingEvents("tok", 15, onUnauthorized),
    ).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on 401 when no refresh callback is provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));

    await expect(listUpcomingEvents("tok")).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on non-401 API errors without retrying", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    const onUnauthorized = vi.fn();

    await expect(
      listUpcomingEvents("tok", 15, onUnauthorized),
    ).rejects.toThrow(/500/);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("returns [] when the response has no items", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await expect(listUpcomingEvents("tok")).resolves.toEqual([]);
  });
});

describe("extractMeetLink", () => {
  it("prefers hangoutLink over location/description", () => {
    expect(
      extractMeetLink({
        hangoutLink: "https://meet.google.com/aaa-bbbb-ccc",
        location: "https://zoom.us/j/999",
      }),
    ).toBe("https://meet.google.com/aaa-bbbb-ccc");
  });

  it("finds zoom links on subdomains", () => {
    expect(
      extractMeetLink({ location: "Zoom: https://company.zoom.us/j/42?pwd=p" }),
    ).toBe("https://company.zoom.us/j/42?pwd=p");
  });

  it("finds meet links inside description text", () => {
    expect(
      extractMeetLink({ description: "join at https://meet.google.com/x-y-z now" }),
    ).toBe("https://meet.google.com/x-y-z");
  });

  it("returns undefined for plain-text locations", () => {
    expect(extractMeetLink({ location: "Room 4B" })).toBeUndefined();
    expect(extractMeetLink({})).toBeUndefined();
  });
});
