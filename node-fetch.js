import fetch from 'node-fetch'; // Ensure node-fetch is installed

async function fetchDDFProperties() {
  try {
    const token = await getAccessToken();
    console.log('Access token:', token);

    const response = await fetch(DDF_URL + `?$filter=City eq 'Caledonia'`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await response.json();
    console.log('DDF API response:', data);

    if (response.ok) {
      return data.value || [];
    } else {
      throw new Error(data.error || 'Failed to fetch DDF properties');
    }
  } catch (error) {
    console.error('Error in fetchDDFProperties:', error);
    return [];
  }
}

// Fetch and save properties function
async function fetchAndSave() {
  try {
    const properties = await fetchDDFProperties();
    console.log('Fetched properties:', properties);

    // Example: saving fetched properties (update as per your requirements)
    await savePropertiesToSupabase(properties);
  } catch (error) {
    console.error('Error in fetching or saving properties:', error);
  }
}

fetchAndSave();
