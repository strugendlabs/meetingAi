// Google Calendar REST client (Task 7).
//
// Lists upcoming events from the primary calendar and extracts join links
// (Google Meet `hangoutLink`, plus Zoom / Teams / Meet URLs found in the
// event location or description). Auto-refreshes once on 401 via callback.

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  meetLink?: string;
}

/** Raw shape of a Google Calendar API event (fields we care about). */
interface GoogleEventItem {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  hangoutLink?: string;
  location?: string;
  description?: string;
}

const EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

// Zoom join, Teams meetup-join, or Google Meet URLs.
const MEETING_LINK_RE =
  /https?:\/\/(?:[\w.-]*zoom\.us\/j\/[^\s<>"']+|teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"']+|meet\.google\.com\/[^\s<>"']+)/i;

/** Prefer the structured hangoutLink; else scan location, then description. */
export function extractMeetLink(item: {
  hangoutLink?: string;
  location?: string;
  description?: string;
}): string | undefined {
  if (item.hangoutLink) return item.hangoutLink;
  for (const text of [item.location, item.description]) {
    if (!text) continue;
    const m = text.match(MEETING_LINK_RE);
    if (m) return m[0];
  }
  return undefined;
}

function toCalendarEvent(item: GoogleEventItem): CalendarEvent {
  return {
    id: item.id,
    title: item.summary ?? "(untitled)",
    start: item.start?.dateTime ?? item.start?.date ?? "",
    end: item.end?.dateTime ?? item.end?.date ?? "",
    meetLink: extractMeetLink(item),
  };
}

function requestEvents(accessToken: string, maxResults: number): Promise<Response> {
  const url = new URL(EVENTS_URL);
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", new Date().toISOString());
  return fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * List upcoming events from the user's primary calendar.
 *
 * On a 401 response, calls `onUnauthorized` (if provided) to obtain a fresh
 * access token and retries exactly once; otherwise throws.
 */
export async function listUpcomingEvents(
  accessToken: string,
  maxResults = 15,
  onUnauthorized?: () => Promise<string>,
): Promise<CalendarEvent[]> {
  let res = await requestEvents(accessToken, maxResults);

  if (res.status === 401 && onUnauthorized) {
    const freshToken = await onUnauthorized();
    res = await requestEvents(freshToken, maxResults);
  }

  if (!res.ok) {
    throw new Error(await describeCalendarError(res));
  }

  const body = (await res.json()) as { items?: GoogleEventItem[] };
  return (body.items ?? []).map(toCalendarEvent);
}

/**
 * Turn a failed Calendar API response into an actionable message. The most
 * common failure after a successful sign-in is a 403 because the Google
 * Calendar API isn't enabled for the project — auth works, but every fetch
 * 403s, which reads as "connect doesn't work". Google's 403 body says so
 * explicitly ("has not been used in project … or it is disabled"); we surface
 * a clear next step instead of a bare status code.
 */
export async function describeCalendarError(res: Response): Promise<string> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    // ignore — fall back to the status code below
  }
  if (res.status === 403) {
    if (/has not been used in project|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(raw)) {
      return "Google Calendar API isn't enabled for this project. Enable it in Google Cloud Console → APIs & Services → Library → Google Calendar API → Enable, then try again.";
    }
    if (/insufficient|scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(raw)) {
      return "Calendar access wasn't granted. Disconnect and sign in again, allowing the calendar permission.";
    }
    return "Google denied the calendar request (403). Check that the Calendar API is enabled and your account has access.";
  }
  return `Calendar API error: ${res.status}`;
}
