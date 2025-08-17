import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY environment variable');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// URL of the XML feed
const XML_URL = 'https://ddfapi.realtor.ca/odata/v1/$metadata
'; // replace with actual XML endpoint

// Fetch and parse XML
async function fetchXMLData() {
  try {
    const response = await fetch(XML_URL);
    if (!response.ok) throw new Error(`Failed to fetch XML: ${response.statusText}`);
    const xmlText = await response.text();

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseAttributeValue: true,
    });

    const jsonData = parser.parse(xmlText);
    return jsonData;
  } catch (error) {
    console.error('Error fetching or parsing XML:', error.message);
    throw error;
  }
}

// Map XML property data to Supabase fields
function mapPropertiesXML(properties) {
  return properties.map(p => ({
    ListOfficeKey: p.AgentDetails?.Office?.ID || null,
    OfficeName: p.AgentDetails?.Office?.Name || null,
    ListingKey: p.ID,
    ListingId: p.ListingID,
    PropertyType: p.PropertyType || p.Building?.Type,
    PropertySubType: p.Building?.Type,
    PublicRemarks: p.PublicRemarks,
    ListPrice: p.Price,
    City: p.Address?.City || 'Unknown',
    CommunityName: p.Address?.CommunityName || p.Address?.City || 'Unknown',
    PostalCode: p.Address?.PostalCode,
    Latitude: p.Latitude || null,
    Longitude: p.Longitude || null,
    BedroomsTotal: p.Building?.BedroomsTotal || null,
    BathroomsTotalInteger: p.Building?.BathroomTotal || null,
    BuildingAreaTotal: p.Building?.SizeInterior || null,
    YearBuilt: p.YearBuilt || null,
    ListingURL: p.MoreInformationLink || null,
    Media: p.Photo?.PropertyPhoto || [],
  }));
}

// Save to Supabase in batches
async function savePropertiesToSupabase(properties) {
  const batchSize = 100;

  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);
    try {
      const { error } = await supabase.from('property').upsert(batch);
      if (error) throw error;
      console.log(`Saved batch ${i / batchSize + 1} (${batch.length} properties).`);
    } catch (error) {
      console.error('Error saving batch:', error.message);
    }
  }
}

// Delete existing properties before importing
async function deleteAllProperties() {
  try {
    const { error } = await supabase.from('property').delete().neq('ListingKey', '');
    if (error) throw error;
    console.log('Deleted all existing properties.');
  } catch (error) {
    console.error('Error deleting properties:', error.message);
  }
}

// Main function
(async function main() {
  try {
    console.log('Starting XML property sync...');
    await deleteAllProperties();

    const xmlData = await fetchXMLData();

    // Handle your XML structure - example assumes multiple <PropertyDetails>
    const propertiesArray = xmlData['RETS-RESPONSE']?.PropertyDetails;
    if (!propertiesArray || propertiesArray.length === 0) {
      console.log('No properties found in XML.');
      return;
    }

    const mappedProperties = mapPropertiesXML(propertiesArray);
    await savePropertiesToSupabase(mappedProperties);

    console.log('✅ XML Data synchronization completed.');
  } catch (error) {
    console.error('Error during XML sync:', error.message);
  }
})();
