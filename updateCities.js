import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

// 🔑 Setup your Supabase credentials
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // needs write access
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 🌍 Function to geocode using OpenStreetMap Nominatim
async function geocodeCity(cityName) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
    cityName + ", Ontario, Canada"
  )}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Supabase-Geocode-Script" },
  });
  const data = await res.json();

  if (data.length > 0) {
    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
    };
  }
  return null;
}

async function updateCities() {
  // 1️⃣ Only fetch cities that have missing lat/lon
  const { data: cities, error } = await supabase
    .from("city_listings")
    .select("id, City, Latitude, Longitude")
    .or("Latitude.is.null,Longitude.is.null");

  if (error) {
    console.error("❌ Error fetching cities:", error);
    return;
  }

  for (const city of cities) {
    // Skip if already has both coordinates
    if (city.Latitude && city.Longitude) {
      console.log(`⏭️ Skipping ${city.City} (already has coords)`);
      continue;
    }

    console.log(`⏳ Geocoding ${city.City}...`);
    const coords = await geocodeCity(city.City);

    if (coords) {
      const { error: updateError } = await supabase
        .from("city_listings")
        .update({
          Latitude: coords.lat,
          Longitude: coords.lon,
        })
        .eq("id", city.id);

      if (updateError) {
        console.error(`❌ Failed to update ${city.City}:`, updateError);
      } else {
        console.log(
          `✅ Updated ${city.City} → ${coords.lat}, ${coords.lon}`
        );
      }
    } else {
      console.log(`⚠️ Could not geocode ${city.City}`);
    }
  }
}

updateCities();
