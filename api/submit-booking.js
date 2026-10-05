import { allowMethods, sendJson } from "./_belle.js";
export {
  BOOKING_ENDPOINT,
  RECENT_APPOINTMENT_DAYS,
  buildBookingBody,
  checkPhoneEligibility,
  findExistingClientByPhone,
  findExistingClientsByPhone
} from "./_booking.js";

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  sendJson(res, 402, { message: "O agendamento só é registrado após a confirmação do pagamento pelo Asaas." });
}
