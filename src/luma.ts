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
  attendeeCount?: number; // Number of people registered/attending
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
          // Log first featured_item structure to see what's available
          if (data.data.featured_items.length > 0) {
            const firstItem = data.data.featured_items[0];
            console.log(`[luma] Featured item fields:`, Object.keys(firstItem));
            if (firstItem.event) {
              console.log(`[luma] Featured item.event fields:`, Object.keys(firstItem.event));
              console.log(`[luma] Featured item.event sample (first 300 chars):`, JSON.stringify(firstItem.event).substring(0, 300));
            }
          }
          events = data.data.featured_items
            .filter((item: any) => item.event) // Only items with event data
            .map((item: any) => {
              // Preserve the item-level url if it exists (contains the event slug)
              const eventObj = item.event || item;
              if (item.url && !eventObj.url) {
                eventObj.url = item.url;
              }
              // Extract guest_count from featured_item level (this is the attendee count!)
              if (item.guest_count !== undefined) {
                eventObj.guest_count = item.guest_count;
                eventObj.num_rsvps = item.guest_count; // Also set as num_rsvps for compatibility
              }
              // Also check ticket_count as a fallback
              if (item.ticket_count !== undefined && eventObj.guest_count === undefined) {
                eventObj.guest_count = item.ticket_count;
                eventObj.num_rsvps = item.ticket_count;
              }
              // Also preserve any item-level fields that might have description/attendee info
              if (item.description && !eventObj.description) {
                eventObj.description = item.description;
              }
              if (item.num_rsvps !== undefined && eventObj.num_rsvps === undefined) {
                eventObj.num_rsvps = item.num_rsvps;
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
          // Log first event structure to see what fields are available
          if (events.length > 0) {
            const firstEvent = events[0];
            console.log(`[luma] Calendar event fields:`, Object.keys(firstEvent));
            if (firstEvent.event) {
              console.log(`[luma] Calendar event.event fields:`, Object.keys(firstEvent.event));
            }
          }
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
  
  // Build location from structured fields - just use city name
  // This avoids postal codes that might be in city_state and redundant region names
  let location: string | undefined;
  if (locationInfo) {
    // Just use the city name - clean and simple
    if (locationInfo.geo_city) {
      location = locationInfo.geo_city;
    } else if (locationInfo.city_state) {
      // Fallback to city_state if geo_city isn't available
      // Try to extract just the city part (before comma if it exists)
      // This removes postal codes like "C1416CLN" that might be at the start
      const cityState = locationInfo.city_state;
      // Split by comma and take the first part that looks like a city name
      // Skip parts that look like postal codes (all caps, alphanumeric, short)
      const parts = cityState.split(',').map(p => p.trim());
      const cityPart = parts.find(part => {
        // Skip if it looks like a postal code (all caps, short, alphanumeric)
        if (part.length <= 10 && /^[A-Z0-9]+$/.test(part)) {
          return false;
        }
        return part.length > 0;
      });
      location = cityPart || parts[0] || cityState;
    }
  }
  
  // If still no location, check if event has coordinate (at least we know it has a location)
  if (!location && event.coordinate) {
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
  
  // Extract description - prefer short description, fallback to full description
  const description = event.description_short || event.description || event.summary;
  
  // Extract attendee count - try various possible field names
  // guest_count from featured_items is the most reliable source
  const attendeeCount = 
    event.guest_count ||
    event.num_rsvps ||
    event.num_attendees ||
    event.attendee_count ||
    event.rsvp_count ||
    event.registered_count ||
    event.going_count ||
    event.attendees_count ||
    event.num_going ||
    event.ticket_count ||
    (typeof event.going === 'number' ? event.going : undefined) ||
    (Array.isArray(event.rsvps) ? event.rsvps.length : undefined) ||
    (Array.isArray(event.going) ? event.going.length : undefined);
  
  return {
    id: eventApiId || `event-${index}`,
    title: event.name || event.title || "Untitled Event",
    url: fullUrl,
    description: description,
    location: location,
    date: event.start_at || event.startAt || event.date || event.start_time,
    eventApiId: eventApiId,
    attendeeCount: attendeeCount,
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
          const lumaEvents = await Promise.all(
            calendarEvents.map(async (eventData, idx) => {
              const event = eventDataToLumaEvent(eventData, calendar.calendar.slug, idx);
              
              // Always try to fetch individual event details to get complete information
              if (event.eventApiId) {
                try {
                  const details = await getEventDetails(event.eventApiId);
                  if (details?.data?.event || details?.event) {
                    const detailedEvent = details.data?.event || details.event;
                    
                    // Log available fields for debugging
                    if (idx === 0) {
                      console.log(`[luma] Sample event detail fields:`, Object.keys(detailedEvent));
                      console.log(`[luma] Sample description fields:`, {
                        description: detailedEvent.description?.substring(0, 100),
                        description_short: detailedEvent.description_short?.substring(0, 100),
                        summary: detailedEvent.summary?.substring(0, 100),
                        bio: detailedEvent.bio?.substring(0, 100),
                        about: detailedEvent.about?.substring(0, 100),
                      });
                      console.log(`[luma] Sample attendee fields:`, {
                        num_rsvps: detailedEvent.num_rsvps,
                        num_attendees: detailedEvent.num_attendees,
                        attendee_count: detailedEvent.attendee_count,
                        rsvp_count: detailedEvent.rsvp_count,
                        registered_count: detailedEvent.registered_count,
                        going_count: detailedEvent.going_count,
                        attendees_count: detailedEvent.attendees_count,
                        num_going: detailedEvent.num_going,
                        going: detailedEvent.going,
                        rsvps: detailedEvent.rsvps,
                        rsvps_count: detailedEvent.rsvps_count,
                        going_users_count: detailedEvent.going_users_count,
                      });
                      // Log full response structure for first event (truncated)
                      console.log(`[luma] Full event detail response (first 500 chars):`, JSON.stringify(detailedEvent).substring(0, 500));
                    }
                    
                    // Update description - try various possible field names
                    const newDescription = 
                      detailedEvent.description_short || 
                      detailedEvent.description || 
                      detailedEvent.summary ||
                      detailedEvent.bio ||
                      detailedEvent.about ||
                      detailedEvent.content;
                    if (newDescription && (!event.description || newDescription.length > event.description.length)) {
                      event.description = newDescription;
                    }
                    
                    // Update attendee count - try all possible field names
                    // Note: guest_count is usually in featured_items, not individual event details
                    const newAttendeeCount = 
                      detailedEvent.guest_count ||
                      detailedEvent.num_rsvps ||
                      detailedEvent.num_attendees ||
                      detailedEvent.attendee_count ||
                      detailedEvent.rsvp_count ||
                      detailedEvent.registered_count ||
                      detailedEvent.going_count ||
                      detailedEvent.attendees_count ||
                      detailedEvent.num_going ||
                      detailedEvent.rsvps_count ||
                      detailedEvent.going_users_count ||
                      detailedEvent.ticket_count ||
                      (typeof detailedEvent.going === 'number' ? detailedEvent.going : undefined) ||
                      (Array.isArray(detailedEvent.rsvps) ? detailedEvent.rsvps.length : undefined) ||
                      (Array.isArray(detailedEvent.going) ? detailedEvent.going.length : undefined) ||
                      (Array.isArray(detailedEvent.going_users) ? detailedEvent.going_users.length : undefined);
                    
                    if (newAttendeeCount !== undefined) {
                      event.attendeeCount = newAttendeeCount;
                    }
                    
                    // Update date if we have a better one
                    const newDate = detailedEvent.start_at || detailedEvent.startAt || detailedEvent.date || detailedEvent.start_time;
                    if (newDate && !event.date) {
                      event.date = newDate;
                    }
                  }
                } catch (error) {
                  // Log error but continue with what we have
                  console.warn(`[luma] Failed to fetch details for event ${event.eventApiId}:`, error);
                }
              }
              
              return event;
            })
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
 * Get place API ID from city name/slug
 * Tries to find the place by slug or name
 */
async function getPlaceApiId(cityName: string): Promise<string | null> {
  // Normalize city name to slug format
  const slug = cityName.toLowerCase().trim().replace(/\s+/g, '-');
  
  // Try to fetch place by slug using discover endpoint
  // First try: https://api2.luma.com/discover/get-place-v2?slug=<slug>
  // Or try: https://api2.luma.com/url?url=<slug>
  const possibleEndpoints = [
    `https://api2.luma.com/discover/get-place-v2?slug=${encodeURIComponent(slug)}`,
    `https://api2.luma.com/url?url=${encodeURIComponent(slug)}`,
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
        // Check if it's a place response
        if (data.place?.api_id) {
          console.log(`[luma] Found place API ID for ${cityName}: ${data.place.api_id}`);
          return data.place.api_id;
        }
        // Check if url endpoint returned place data
        if (data.kind === "place" && data.data?.place?.api_id) {
          console.log(`[luma] Found place API ID for ${cityName}: ${data.data.place.api_id}`);
          return data.data.place.api_id;
        }
      }
    } catch (error) {
      // Try next endpoint
      continue;
    }
  }
  
  console.warn(`[luma] Could not find place API ID for: ${cityName}`);
  return null;
}

/**
 * Fetch events from a place using the place API ID
 */
async function getEventsByPlace(placeApiId: string, limit: number = 10): Promise<LumaEvent[]> {
  const url = `https://api2.luma.com/discover/get-place-v2?discover_place_api_id=${encodeURIComponent(placeApiId)}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    
    if (!response.ok) {
      console.warn(`[luma] Failed to fetch place data: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    const place = data.place;
    
    if (!place || !place.featured_event_api_ids || !Array.isArray(place.featured_event_api_ids)) {
      console.warn(`[luma] No featured events found for place ${placeApiId}`);
      return [];
    }
    
    console.log(`[luma] Found ${place.featured_event_api_ids.length} featured events for place ${place.name || placeApiId}`);
    
    // Fetch individual event details for each featured event
    const eventPromises = place.featured_event_api_ids
      .slice(0, limit)
      .map(async (eventApiId: string, index: number) => {
        try {
          const eventDetails = await getEventDetails(eventApiId);
          if (eventDetails?.data?.event || eventDetails?.event) {
            const event = eventDetails.data?.event || eventDetails.event;
            return eventDataToLumaEvent(event, '', index);
          }
        } catch (error) {
          console.warn(`[luma] Failed to fetch event ${eventApiId}:`, error);
        }
        return null;
      });
    
    const events = await Promise.all(eventPromises);
    return events.filter((e): e is LumaEvent => e !== null);
  } catch (error) {
    console.error(`[luma] Error fetching events by place ${placeApiId}:`, error);
    return [];
  }
}

/**
 * Search for events by place using Luma API
 * Uses the discover/get-place-v2 endpoint when available
 */
async function searchByPlace(query: string, limit: number): Promise<LumaEvent[]> {
  // First, try to get the place API ID
  const placeApiId = await getPlaceApiId(query);
  
  if (placeApiId) {
    // Use the location API to get events
    const events = await getEventsByPlace(placeApiId, limit);
    if (events.length > 0) {
      return events;
    }
  }
  
  // Fallback: Try searching the place name as a topic
  // Some cities might have topic/category pages (e.g., "san-francisco")
  const slug = normalizeToSlug(query);
  const urlEndpoint = `https://api2.luma.com/url?url=${encodeURIComponent(slug)}`;
  
  console.log(`[luma] Searching place as topic (fallback): ${query} via ${urlEndpoint}`);
  
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
export function formatEventsForTelegram(events: LumaEvent[], totalEvents?: number, startIndex: number = 0): string {
  if (events.length === 0) {
    return "No events found. Please try a different search query.";
  }
  
  const lines = events.map((event, index) => {
    const num = index + 1;
    const title = event.title || "Untitled Event";
    const url = event.url;
    
    // Build details section with description and attendee count
    const details: string[] = [];
    
    // Add location if available
    if (event.location) {
      details.push(event.location);
    }
    
    // Add date if available
    if (event.date) {
      try {
        const dateObj = new Date(event.date);
        if (!isNaN(dateObj.getTime())) {
          // Format as "Jan 15, 2025" or "Jan 15" if current year
          const now = new Date();
          const isCurrentYear = dateObj.getFullYear() === now.getFullYear();
          const dateStr = isCurrentYear
            ? dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          details.push(dateStr);
        }
      } catch (e) {
        // If date parsing fails, try to use as-is if it's a string
        if (typeof event.date === 'string') {
          details.push(event.date);
        }
      }
    }
    
    // Add attendee count if available
    if (event.attendeeCount !== undefined && event.attendeeCount > 0) {
      details.push(`${event.attendeeCount} ${event.attendeeCount === 1 ? 'person' : 'people'} going`);
    }
    
    // Add description (1-2 lines, truncated if too long)
    if (event.description) {
      // Clean up description - remove HTML tags, extra whitespace
      let cleanDesc = event.description
        .replace(/<[^>]+>/g, '') // Remove HTML tags
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();
      
      // Limit to ~120 characters for 1-2 lines
      if (cleanDesc.length > 120) {
        // Try to truncate at a sentence boundary
        const truncated = cleanDesc.substring(0, 120);
        const lastPeriod = truncated.lastIndexOf('.');
        const lastSpace = truncated.lastIndexOf(' ');
        
        if (lastPeriod > 80) {
          cleanDesc = truncated.substring(0, lastPeriod + 1);
        } else if (lastSpace > 80) {
          cleanDesc = truncated.substring(0, lastSpace) + '...';
        } else {
          cleanDesc = truncated + '...';
        }
      }
      
      details.push(cleanDesc);
    }
    
    // Format the line
    let line = `${num}. [${title}](${url})`;
    if (details.length > 0) {
      line += `\n   ${details.join(' • ')}`;
    }
    
    return line;
  });
  
  let header = `Found ${events.length} event${events.length > 1 ? "s" : ""}`;
  if (totalEvents !== undefined && totalEvents > events.length) {
    header = `Showing ${startIndex + 1}-${startIndex + events.length} of ${totalEvents} events`;
  }
  
  return `${header}:\n\n${lines.join("\n\n")}`;
}

