import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function updateCities() {
  try {
    // 1. Get all cities
    const { data: cities, error } = await supabase
      .from("city_listings")
      .select("City, Latitude, Longitude");

    if (error) throw error;

    for (const city of cities) {
      if (!city.Latitude || !city.Longitude) {
        console.log(`Fetching coordinates for: ${city.City}`);

        const url = `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(
          city.City
        )}&country=Canada&format=json&limit=1`;

        const res = await fetch(url, {
          headers: { "User-Agent": "getsetsold-bot/1.0" },
        });
        const data = await res.json();

        if (data.length > 0) {
          const lat = parseFloat(data[0].lat);
          const lon = parseFloat(data[0].lon);

          const { error: updateError } = await supabase
            .from("city_listings")
            .update({ Latitude: lat, Longitude: lon })
            .eq("City", city.City);

          if (updateError) throw updateError;

          console.log(`✅ Updated ${city.City} → ${lat}, ${lon}`);
        } else {
          console.warn(`⚠️ No coordinates found for ${city.City}`);
        }
      }
    }

    console.log("🎉 Update completed successfully.");
  } catch (err) {
    console.error("❌ Script failed:", err.message);
    process.exit(1); // keeps GitHub Action marked as failed
  }
}

updateCities();
