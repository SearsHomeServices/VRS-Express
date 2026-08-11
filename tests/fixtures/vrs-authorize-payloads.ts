export const signedTinaPhotoUrl =
  "https://tina.example.test/download/photo%2Fwasher.jpg?signature=abc%2B123&expires=1786406400";

export const validV5AuthorizePayload = {
  service_order: "13538277",
  tech_id: "0123456",
  tech_phone: "+12145550199",
  tech_name: "Carlos Rivera",
  reason_for_call: "authorization" as const,
  callback_url:
    "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
  callback_secret: "sasha-test-secret-with-at-least-32-characters",
  parts: [{
    part_id: "WPW10503278",
    part_description: "Electronic Control Board",
    sell_price: 245,
    part_function: "Controls wash cycle timing and motor speed.",
  }],
  customer_name: "Maria Gonzalez",
  customer_address: "742 Evergreen Terrace, Hagerstown, MD 21740",
  service_address: "742 Evergreen Terrace, Hagerstown, MD 21740",
  brand: "Whirlpool",
  model_number: "WTW5000DW1",
  serial_number: "C31290822",
  appliance_type: "Washer",
  appliance_age: 4,
  labor_amount: 120,
  tax_amount: 15.6,
  part_price: 245,
  appliance_location: "laundry room",
  failure_cause: "normal-wear" as const,
  tech_recommendation: "repair" as const,
  repair_replace_rationale:
    "Board failure is isolated and repair is within the coverage threshold.",
  appliance_grade: "mid" as const,
  partner_id: "ahs",
  appliance_photos: ["https://srdm.example.com/photo_1.jpg"],
  comments: [{
    tech_id: "0123456",
    work_item: "failure_diagnosis" as const,
    text: "Diagnostic code F7E1.",
    timestamp: "2026-05-12T13:55:00Z",
  }],
};

export const validV8AuthorizePayload = {
  ...validV5AuthorizePayload,
  appliance_color: "stainless steel",
  contract_number: "1234567890",
  purchase_year: 2022,
  symptom: "Washer not draining",
  appliance_grade: "mid" as const,
  partner_id: "American Home Shield",
  appliance_photos: [signedTinaPhotoUrl],
  comments: [],
};
