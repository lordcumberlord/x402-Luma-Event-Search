/**
 * Luma event search functionality
 * 
 * This module handles searching for events on Luma.com using their public API
 * API endpoints discovered:
 * - Topics: https://api2.luma.com/url?url=<topic-slug>
 * - Places: https://api2.luma.com/discover/bootstrap-page?featured_place_api_id=<place-id>
 */

export type LumaSearchParams = {
  query: string;
  searchType: "place" | "topic";
  limit?: number;
};

export type LumaEvent = {
  id: string;
  title: string;
  url: string;
  description?: string;
  location?: string;
  date?: string;
  calendarName?: string;
  eventApiId?: string; // For fetching individual event details if needed
};

type LumaCalendar = {
  api_id: string;
  calendar: {
    name: string;
    slug: string;
    api_id: string;
    website?: string;
    geo_city?: string;
    geo_region?: string;
    geo_country?: string;
    description_short?: string;
  };
  event_count: number;
  start_at?: string;
  end_at?: string;
};

type LumaTopicResponse = {
  kind: string;
  data: {
    category?: {
      name: string;
      slug: string;
      event_count: number;
    };
    timeline_calendars: LumaCalendar[];
    num_upcoming_events?: number;
  };
};

type LumaPlaceResponse = {
  // TODO: We need to inspect the bootstrap-page response structure
  // For now, we'll handle it similarly
  [key: string]: any;
};

/**
 * Normalize query to slug format (lowercase, spaces to hyphens, etc.)
 */
function normalizeToSlug(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/**
 * Build Luma event URL from event slug/ID
 * Individual events use format: https://luma.com/{event-slug}
 * Calendar fallback uses: https://luma.com/{calendar-slug}
 */
function buildEventUrl(calendarSlug: string, eventUrl?: string, eventApiId?: string): string {
  // If we have an event slug/URL, use it directly for individual event page
  if (eventUrl) {
    // Individual event URL: https://luma.com/{event-slug}
    // Remove any calendar prefix if present
    const cleanEventUrl = eventUrl.replace(/^[^/]+\//, ''); // Remove "calendar-slug/" prefix if present
    return `https://luma.com/${cleanEventUrl}`;
  }
  
  // If we have event API ID, try to construct URL from it
  // Event API IDs might be in format like "evt-xxx" or just the slug
  if (eventApiId) {
    // If it's an API ID format (starts with "evt-"), we might need to fetch the actual slug
    // For now, try using it directly if it looks like a slug
    if (!eventApiId.startsWith('evt-')) {
      return `https://luma.com/${eventApiId}`;
    }
  }
  
  // Calendar URL fallback
  return `https://luma.com/${calendarSlug}`;
}

/**
 * Fetch events from a calendar using the calendar slug
 */
async function getCalendarEvents(calendarSlug: string, calendarApiId: string, limit: number = 10): Promise<any[]> {
  // Try the URL endpoint with calendar slug first (might return calendar page with events)
  const urlEndpoint = `https://api2.luma.com/url?url=${encodeURIComponent(calendarSlug)}`;
  
  try {
    const response = await fetch(urlEndpoint, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    
    if (response.ok) {
      const data = await response.json();
      
      // Check if it's a calendar page with events
      if (data.kind === "calendar" || data.data?.calendar) {
        // Look for events in various possible locations
        // featured_items contains events with structure: { api_id, event: { ... } }
        let events: any[] = [];
        
        if (data.data?.featured_items && Array.isArray(data.data.featured_items)) {
          // Extract event objects from featured_items
          // featured_items structure: { api_id, event: { ... }, url: "calendar-slug/event-slug" }
          events = data.data.featured_items
            .filter((item: any) => item.event) // Only items with event data
            .map((item: any) => {
              // Preserve the item-level url if it exists (contains the event slug)
              const eventObj = item.event || item;
              if (item.url && !eventObj.url) {
                eventObj.url = item.url;
              }
              return eventObj;
            });
        } else {
          // Try other possible locations
          events = 
            data.data?.events ||
            data.data?.upcoming_events ||
            data.data?.timeline_events ||
            data.events ||
            data.upcoming_events ||
            data.timeline_events ||
            [];
        }
        
        if (Array.isArray(events) && events.length > 0) {
          console.log(`[luma] Found ${events.length} events from calendar ${calendarSlug} via URL endpoint`);
          return events.slice(0, limit);
        }
      }
    }
  } catch (error) {
    console.warn(`[luma] URL endpoint failed for calendar ${calendarSlug}:`, error);
  }
  
  // Fallback: Try direct calendar API endpoints
  const possibleEndpoints = [
    `https://api2.luma.com/calendar/${calendarApiId}/events`,
    `https://api2.luma.com/v1/calendar/${calendarApiId}/events`,
    `https://api2.luma.com/calendar/get-events?calendar_api_id=${calendarApiId}`,
    `https://api2.luma.com/v1/calendar/get-events?calendar_api_id=${calendarApiId}`,
  ];
  
  for (const endpoint of possibleEndpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "Accept": "application/json",
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        // Try to extract events from various possible response structures
        const events = data.events || data.data?.events || data.data || (Array.isArray(data) ? data : []);
        if (Array.isArray(events) && events.length > 0) {
          console.log(`[luma] Found ${events.length} events from calendar ${calendarApiId} via ${endpoint}`);
          return events.slice(0, limit);
        }
      }
    } catch (error) {
      // Try next endpoint
      continue;
    }
  }
  
  console.warn(`[luma] Could not find events endpoint for calendar ${calendarSlug} (${calendarApiId})`);
  return [];
}

/**
 * Convert individual event data to LumaEvent
 */
function eventDataToLumaEvent(eventData: any, calendarSlug: string, index: number): LumaEvent {
  const event = eventData.event || eventData;
  const locationInfo = event.geo_address_info;
  
  let location: string | undefined;
  if (locationInfo?.city_state) {
    location = locationInfo.city_state;
  } else if (event.coordinate) {
    // Could geocode coordinates, but for now just note it has coordinates
    location = "Location available";
  }
  
  // Extract event URL/slug - could be in various fields
  const eventUrl = event.url || event.slug || event.event_url;
  const eventApiId = event.api_id || event.id;
  
  // Try to get the event slug from the URL if it's a full URL
  let eventSlug: string | undefined;
  if (eventUrl) {
    // If it's already just a slug (no slashes), use it directly
    if (!eventUrl.includes('/')) {
      eventSlug = eventUrl;
    } else {
      // Extract slug from URL like "calendar-slug/event-slug" or full URL
      const parts = eventUrl.split('/').filter(Boolean);
      eventSlug = parts[parts.length - 1]; // Get last part
    }
  }
  
  const fullUrl = buildEventUrl(calendarSlug, eventSlug, eventApiId);
  
  return {
    id: eventApiId || `event-${index}`,
    title: event.name || event.title || "Untitled Event",
    url: fullUrl,
    description: event.description_short || event.description,
    location: location,
    date: event.start_at || event.startAt || event.date,
    eventApiId: eventApiId,
  };
}

/**
 * Convert Luma calendar to LumaEvent (legacy - for calendars without individual events)
 */
function calendarToEvent(calendar: LumaCalendar, index: number): LumaEvent {
  const locationParts = [
    calendar.calendar.geo_city,
    calendar.calendar.geo_region,
    calendar.calendar.geo_country,
  ].filter(Boolean);
  
  return {
    id: calendar.api_id || `event-${index}`,
    title: calendar.calendar.name,
    url: buildEventUrl(calendar.calendar.slug),
    description: calendar.calendar.description_short,
    location: locationParts.length > 0 ? locationParts.join(", ") : undefined,
    date: calendar.start_at || undefined,
    calendarName: calendar.calendar.name,
  };
}

/**
 * Search for events by topic using Luma API
 * Fetches individual events from calendars, not just calendar links
 */
async function searchByTopic(query: string, limit: number): Promise<LumaEvent[]> {
  const slug = normalizeToSlug(query);
  const url = `https://api2.luma.com/url?url=${encodeURIComponent(slug)}`;
  
  console.log(`[luma] Searching topic: ${slug} via ${url}`);
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    
    if (!response.ok) {
      console.error(`[luma] Topic search failed: ${response.status} ${response.statusText}`);
      return [];
    }
    
    const data: LumaTopicResponse = await response.json();
    
    if (data.kind !== "category" || !data.data.timeline_calendars) {
      console.log(`[luma] No category data found for topic: ${query}`);
      return [];
    }
    
    // Get calendars with events
    const calendars = data.data.timeline_calendars
      .filter(cal => cal.event_count > 0)
      .slice(0, Math.min(limit, 5)); // Limit to 5 calendars to avoid too many API calls
    
    console.log(`[luma] Found ${calendars.length} calendars, fetching individual events...`);
    
    // Fetch individual events from each calendar
    const allEvents: LumaEvent[] = [];
    const eventsPerCalendar = Math.ceil(limit / calendars.length);
    
    for (const calendar of calendars) {
      try {
        const calendarEvents = await getCalendarEvents(
          calendar.calendar.slug, 
          calendar.calendar.api_id, 
          eventsPerCalendar
        );
        
        if (calendarEvents.length > 0) {
          const lumaEvents = calendarEvents.map((eventData, idx) => 
            eventDataToLumaEvent(eventData, calendar.calendar.slug, idx)
          );
          allEvents.push(...lumaEvents);
          
          // Stop if we have enough events
          if (allEvents.length >= limit) {
            break;
          }
        } else {
          // If no individual events found, fallback to calendar link
          console.warn(`[luma] No individual events found for calendar ${calendar.calendar.slug}, using calendar link`);
          allEvents.push(calendarToEvent(calendar, allEvents.length));
        }
      } catch (error) {
        console.warn(`[luma] Failed to fetch events from calendar ${calendar.calendar.slug}:`, error);
        // Fallback: use calendar as event if we can't get individual events
        allEvents.push(calendarToEvent(calendar, allEvents.length));
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Limit to requested number
    const finalEvents = allEvents.slice(0, limit);
    
    console.log(`[luma] Found ${finalEvents.length} individual events for topic: ${query}`);
    return finalEvents;
  } catch (error) {
    console.error(`[luma] Error searching topic "${query}":`, error);
    return [];
  }
}

/**
 * Fetch individual event details to get location information
 */
async function getEventDetails(eventApiId: string): Promise<any> {
  const url = `https://api2.luma.com/event/get?event_api_id=${eventApiId}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    
    if (!response.ok) {
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error(`[luma] Error fetching event details for ${eventApiId}:`, error);
    return null;
  }
}

/**
 * Extract location from event data
 */
function extractLocationFromEvent(eventData: any): string | undefined {
  if (!eventData) return undefined;
  
  // Try various location fields
  const locationFields = [
    eventData.location,
    eventData.venue?.name,
    eventData.venue?.address,
    eventData.geo_city,
    eventData.geo_region,
    eventData.geo_country,
    eventData.address,
    eventData.place?.name,
    eventData.coordinate,
  ];
  
  // Build location string from available fields
  const parts: string[] = [];
  
  if (eventData.geo_city) parts.push(eventData.geo_city);
  if (eventData.geo_region && eventData.geo_region !== eventData.geo_city) {
    parts.push(eventData.geo_region);
  }
  if (eventData.geo_country) parts.push(eventData.geo_country);
  
  if (parts.length > 0) {
    return parts.join(", ");
  }
  
  // Fallback to other fields
  for (const field of locationFields) {
    if (typeof field === "string" && field.trim()) {
      return field.trim();
    }
  }
  
  return undefined;
}

/**
 * Search for events by place using Luma API
 * 
 * Since Luma doesn't support direct location search, we:
 * 1. Try searching the place name as a topic (some cities have topic pages)
 * 2. If that doesn't work, return a helpful message
 * 
 * Note: We could potentially search by topic and then filter by location
 * if we fetch individual event details, but that would be slow and hit rate limits.
 */
async function searchByPlace(query: string, limit: number): Promise<LumaEvent[]> {
  // Approach: Try searching the place name as a topic
  // Some cities might have topic/category pages (e.g., "san-francisco")
  const slug = normalizeToSlug(query);
  const urlEndpoint = `https://api2.luma.com/url?url=${encodeURIComponent(slug)}`;
  
  console.log(`[luma] Searching place as topic: ${query} via ${urlEndpoint}`);
  
  try {
    const response = await fetch(urlEndpoint, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    
    if (response.ok) {
      const data: LumaTopicResponse = await response.json();
      
      // Check if it returned category/calendar data
      if (data.data?.timeline_calendars) {
        const calendars = data.data.timeline_calendars
          .filter(cal => cal.event_count > 0)
          .slice(0, limit);
        
        const events = calendars.map((cal, idx) => calendarToEvent(cal, idx));
        
        if (events.length > 0) {
          console.log(`[luma] Found ${events.length} events for place (as topic): ${query}`);
          return events;
        }
      }
    }
  } catch (error) {
    console.error(`[luma] Error searching place "${query}":`, error);
  }
  
  // If no results, return empty array
  // The user will see "No events found" message
  console.log(`[luma] No events found for place: ${query}`);
  return [];
}

/**
 * Search for events on Luma
 * 
 * @param params Search parameters
 * @returns Array of event links and details
 */
export async function searchLumaEvents(params: LumaSearchParams): Promise<LumaEvent[]> {
  const { query, searchType, limit = 10 } = params;
  
  console.log(`[luma] Searching for events: type=${searchType}, query="${query}", limit=${limit}`);
  
  if (searchType === "topic") {
    return await searchByTopic(query, limit);
  } else {
    return await searchByPlace(query, limit);
  }
}

/**
 * Format events as a list of links for Telegram
 */
export function formatEventsForTelegram(events: LumaEvent[]): string {
  if (events.length === 0) {
    return "No events found. Please try a different search query.";
  }
  
  const lines = events.map((event, index) => {
    const num = index + 1;
    const title = event.title || "Untitled Event";
    const url = event.url;
    
    // Add location or description if available
    let details = "";
    if (event.location) {
      details = ` - ${event.location}`;
    } else if (event.description) {
      const desc = event.description.length > 50 
        ? event.description.substring(0, 47) + "..."
        : event.description;
      details = ` - ${desc}`;
    }
    
    return `${num}. [${title}](${url})${details}`;
  });
  
  return `Found ${events.length} event${events.length > 1 ? "s" : ""}:\n\n${lines.join("\n")}`;
}

