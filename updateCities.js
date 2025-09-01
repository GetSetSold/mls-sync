
import fetch from 'node-fetch';

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co'; // can also read from env
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);


// Function to geocode a city using OpenStreetMap Nominatim
async function geocodeCity(cityName) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cityName + ', Ontario, Canada')}&limit=1`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Supabase-CityUpdater/1.0' },
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

// Main function to update cities
async function updateCities() {
  try {
    const { data: cities, error } = await supabase
      .from('city_listings')
      .select('City, Latitude, Longitude')
      .or('Latitude.is.null,Longitude.is.null'); // only cities missing coords

    if (error) throw error;

    for (const city of cities) {
      console.log(`⏳ Processing ${city.City}...`);

      const coords = await geocodeCity(city.City);

      if (coords) {
        const { error: updateError } = await supabase
          .from('city_listings')
          .update({
            Latitude: coords.lat,
            Longitude: coords.lon,
          })
          .eq('City', city.City); // update by City name

        if (updateError) {
          console.error(`❌ Failed to update ${city.City}:`, updateError);
        } else {
          console.log(`✅ Updated ${city.City} → ${coords.lat}, ${coords.lon}`);
        }
      } else {
        console.warn(`⚠️ Could not find coordinates for ${city.City}`);
      }
    }

    console.log('🎉 All cities processed.');
  } catch (err) {
    console.error('❌ Script failed:', err.message);
    process.exit(1); // fail workflow if there’s an error
  }
}

updateCities();
