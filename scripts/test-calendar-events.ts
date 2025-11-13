/**
 * Test script to find the correct endpoint for getting events from a calendar
 * Run with: bun run scripts/test-calendar-events.ts
 */

// Test with a known calendar slug from the crypto search results
const calendarSlug = "websummit"; // From the test results
const calendarApiId = "evgrp-WYJxELZ9Vfz4iXi"; // From the test results

console.log(`Testing calendar: ${calendarSlug} (${calendarApiId})\n`);

// Test 1: URL endpoint with calendar slug
console.log("=".repeat(60));
console.log("Test 1: URL endpoint with calendar slug");
console.log("=".repeat(60));
const urlEndpoint = `https://api2.luma.com/url?url=${calendarSlug}`;
console.log(`URL: ${urlEndpoint}\n`);

try {
  const response = await fetch(urlEndpoint, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "application/json",
    },
  });

  if (response.ok) {
    const data = await response.json();
    console.log("Response structure:");
    console.log(JSON.stringify(data, null, 2).substring(0, 2000));
    
    // Look for events
    const events = 
      data.data?.events ||
      data.data?.upcoming_events ||
      data.data?.timeline_events ||
      data.events ||
      data.upcoming_events ||
      data.timeline_events ||
      [];
    
    if (Array.isArray(events) && events.length > 0) {
      console.log(`\n✅ Found ${events.length} events!`);
      console.log("First event:", JSON.stringify(events[0], null, 2).substring(0, 500));
    } else {
      console.log("\n⚠️  No events array found in response");
      console.log("Response keys:", Object.keys(data));
      if (data.data) {
        console.log("Data keys:", Object.keys(data.data));
      }
    }
  } else {
    console.log(`❌ Failed: ${response.status} ${response.statusText}`);
  }
} catch (error) {
  console.error("❌ Error:", error);
}

// Test 2: Direct calendar API endpoints
console.log("\n" + "=".repeat(60));
console.log("Test 2: Direct calendar API endpoints");
console.log("=".repeat(60));

const endpoints = [
  `https://api2.luma.com/calendar/${calendarApiId}/events`,
  `https://api2.luma.com/v1/calendar/${calendarApiId}/events`,
  `https://api2.luma.com/calendar/get-events?calendar_api_id=${calendarApiId}`,
  `https://api2.luma.com/v1/calendar/get-events?calendar_api_id=${calendarApiId}`,
];

for (const endpoint of endpoints) {
  console.log(`\nTrying: ${endpoint}`);
  try {
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Success! Response keys:`, Object.keys(data));
      const events = data.events || data.data?.events || data.data || [];
      if (Array.isArray(events) && events.length > 0) {
        console.log(`   Found ${events.length} events!`);
        console.log("   First event preview:", JSON.stringify(events[0], null, 2).substring(0, 300));
        break; // Found working endpoint
      }
    } else {
      console.log(`   ❌ ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.log(`   ❌ Error:`, error);
  }
}

console.log("\n" + "=".repeat(60));
console.log("✅ Tests complete!");
console.log("=".repeat(60));

