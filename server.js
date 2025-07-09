import fastify from 'fastify'; // Import Fastify once
import fetch from 'node-fetch';

const TOKEN_URL = "https://identity.crea.ca/connect/token";
const CLIENT_ID = "***PURGED-DDF-CLIENT-ID***";
const CLIENT_SECRET = "***PURGED-DDF-CLIENT-SECRET***";
const DDF_URL = "https://ddfapi.realtor.ca/odata/v1/Property";

// Function to get access token
async function getAccessToken() {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "DDFApi_Read",
    }),
  });

  const data = await response.json();

  if (response.ok) {
    return data.access_token;
  } else {
    throw new Error("Failed to fetch token");
  }
}

// Function to fetch property data for Caledonia
async function fetchCaledoniaProperties() {
  const token = await getAccessToken();
  const response = await fetch(DDF_URL + `?$filter=City eq 'Caledonia'`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await response.json();

  if (response.ok) {
    return data.value; // Assuming 'value' contains the list of properties
  } else {
    throw new Error("Failed to fetch Caledonia properties");
  }
}

// Map the API response to your table fields
function mapToTableFields(properties) {
  return properties.map(property => ({
    listingKey: property.ListingKey,
    listOfficeKey: property.ListOfficeKey,
    availabilityDate: property.AvailabilityDate,
    propertySubtype: property.PropertySubtype,
    documentsAvailable: property.DocumentsAvailable,
    leaseAmount: property.LeaseAmount,
    leaseAmountFrequency: property.LeaseAmountFrequency,
    businessType: property.BusinessType,
    waterBodyName: property.WaterBodyName,
    view: property.View,
    numberOfBuildings: property.NumberOfBuildings,
    numberOfUnitsTotal: property.NumberOfUnitsTotal,
    lotFeatures: property.LotFeatures,
    lotSizeArea: property.LotSizeArea,
    lotSizeDimensions: property.LotSizeDimensions,
    lotSizeUnits: property.LotSizeUnits,
    poolFeatures: property.PoolFeatures,
    roadSurfaceType: property.RoadSurfaceType,
    currentUse: property.CurrentUse,
    anchorCoTenants: property.AnchorCoTenants,
    waterfrontFeatures: property.WaterfrontFeatures,
    communityFeatures: property.CommunityFeatures,
    appliances: property.Appliances,
    otherEquipment: property.OtherEquipment,
    totalActualRent: property.TotalActualRent,
    existingLeaseType: property.ExistingLeaseType,
    associationFee: property.AssociationFee,
    associationFeeFrequency: property.AssociationFeeFrequency,
    associationName: property.AssociationName,
    associationFeeIncludes: property.AssociationFeeIncludes,
    originalEntryTimestamp: property.OriginalEntryTimestamp,
    modificationTimestamp: property.ModificationTimestamp,
    listingId: property.ListingId,
    standardStatus: property.StandardStatus,
    statusChangeTimestamp: property.StatusChangeTimestamp,
    publicRemarks: property.PublicRemarks,
    listPrice: property.ListPrice,
    inclusions: property.Inclusions,
    coListOfficeKey: property.CoListOfficeKey,
    coListAgentKey: property.CoListAgentKey,
    listAgentKey: property.ListAgentKey,
    internetAddressDisplayYN: property.InternetAddressDisplayYN,
    listingUrl: property.ListingUrl,
    originatingSystemName: property.OriginatingSystemName,
    photosCount: property.PhotosCount,
    photosChangeTimestamp: property.PhotosChangeTimestamp,
    commonInterest: property.CommonInterest,
    listAOR: property.ListAOR,
    unparsedAddress: property.UnparsedAddress,
    postalCode: property.PostalCode,
    subdivisionName: property.SubdivisionName,
    stateOrProvince: property.StateOrProvince,
    streetDirPrefix: property.StreetDirPrefix,
    streetDirSuffix: property.StreetDirSuffix,
    streetName: property.StreetName,
    streetNumber: property.StreetNumber,
    streetSuffix: property.StreetSuffix,
    unitNumber: property.UnitNumber,
    country: property.Country,
    city: property.City,
    directions: property.Directions,
    latitude: property.Latitude,
    longitude: property.Longitude,
    cityRegion: property.CityRegion,
    mapCoordinateVerifiedYN: property.MapCoordinateVerifiedYN,
    parkingTotal: property.ParkingTotal,
    yearBuilt: property.YearBuilt,
    bathroomsPartial: property.BathroomsPartial,
    bathroomsTotalInteger: property.BathroomsTotalInteger,
    bedroomsTotal: property.BedroomsTotal,
    buildingAreaTotal: property.BuildingAreaTotal,
    buildingAreaUnits: property.BuildingAreaUnits,
    buildingFeatures: property.BuildingFeatures,
    aboveGradeFinishedArea: property.AboveGradeFinishedArea,
    aboveGradeFinishedAreaUnits: property.AboveGradeFinishedAreaUnits,
    aboveGradeFinishedAreaSource: property.AboveGradeFinishedAreaSource,
    aboveGradeFinishedAreaMinimum: property.AboveGradeFinishedAreaMinimum,
    aboveGradeFinishedAreaMaximum: property.AboveGradeFinishedAreaMaximum,
    belowGradeFinishedArea: property.BelowGradeFinishedArea,
    belowGradeFinishedAreaUnits: property.BelowGradeFinishedAreaUnits,
    belowGradeFinishedAreaSource: property.BelowGradeFinishedAreaSource,
    belowGradeFinishedAreaMinimum: property.BelowGradeFinishedAreaMinimum,
    belowGradeFinishedAreaMaximum: property.BelowGradeFinishedAreaMaximum,
    livingArea: property.LivingArea,
    livingAreaUnits: property.LivingAreaUnits,
    livingAreaSource: property.LivingAreaSource,
    livingAreaMinimum: property.LivingAreaMinimum,
    livingAreaMaximum: property.LivingAreaMaximum,
    fireplacesTotal: property.FireplacesTotal,
    fireplaceYN: property.FireplaceYN,
    fireplaceFeatures: property.FireplaceFeatures,
    architecturalStyle: property.ArchitecturalStyle,
    heating: property.Heating,
    foundationDetails: property.FoundationDetails,
    basement: property.Basement,
    exteriorFeatures: property.ExteriorFeatures,
    flooring: property.Flooring,
    parkingFeatures: property.ParkingFeatures,
    cooling: property.Cooling,
    propertyCondition: property.PropertyCondition,
    roof: property.Roof,
    constructionMaterials: property.ConstructionMaterials,
    stories: property.Stories,
    propertyAttachedYN: property.PropertyAttachedYN,
    accessibilityFeatures: property.AccessibilityFeatures,
    bedroomsAboveGrade: property.BedroomsAboveGrade,
    bedroomsBelowGrade: property.BedroomsBelowGrade,
    zoning: property.Zoning,
    zoningDescription: property.ZoningDescription,
    taxAnnualAmount: property.TaxAnnualAmount,
    taxYear: property.TaxYear,
    structureType: property.StructureType,
    utilities: property.Utilities,
    irrigationSource: property.IrrigationSource,
    waterSource: property.WaterSource,
    sewer: property.Sewer,
    electric: property.Electric,
    media: property.Media,
    rooms: property.Rooms,
  }));
}

// Create Fastify instance
const app = fastify({ logger: true });

// Fastify route to fetch properties and map them
app.get("/caledonia-properties", async (request, reply) => {
  try {
    const properties = await fetchCaledoniaProperties();
    const mappedProperties = mapToTableFields(properties);

    // Send the mapped properties as the response
    reply.send({ properties: mappedProperties });
  } catch (error) {
    console.error("Error fetching Caledonia properties:", error);
    reply.status(500).send({ error: "Failed to fetch properties" });
  }
});

app.listen({ port: process.env.PORT || 3001, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server running at ${address}`);
});

