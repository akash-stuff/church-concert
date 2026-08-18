'use strict';

const { z } = require('zod');
const { badRequest, normalisePhone } = require('./helpers');

const trimmed = (min, max) => z.string().trim().min(min).max(max);

const phone = z
  .string()
  .trim()
  .min(7)
  .max(24)
  .transform((value, ctx) => {
    const normalised = normalisePhone(value);
    if (!normalised) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a number with country code, for example +919876543210.',
      });
      return z.NEVER;
    }
    return normalised;
  });

const password = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(200)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
    message: 'Include an uppercase letter, a lowercase letter and a number.',
  });

const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(190);

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.');

const registerSchema = z.object({
  full_name: trimmed(2, 120),
  email,
  mobile_number: phone,
  whatsapp_number: phone,
  password,
  date_of_birth: isoDate,
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']),
  address: trimmed(5, 500),
  emergency_contact: phone,
  accept_terms: z.literal(true, { errorMap: () => ({ message: 'Accept the terms to continue.' }) }),
  confirm_age: z.literal(true, {
    errorMap: () => ({ message: 'Confirm that you are 18 or older.' }),
  }),
});

const loginSchema = z.object({
  identifier: trimmed(3, 190), // email, mobile or WhatsApp number
  password: z.string().min(1).max(200),
});

const adminLoginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

const verifyWhatsappSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'Enter the numeric code from WhatsApp.'),
});

const forgotPasswordSchema = z.object({ email });

const resetPasswordSchema = z.object({
  token: trimmed(32, 200),
  password,
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: password,
});

const updateProfileSchema = z
  .object({
    full_name: trimmed(2, 120).optional(),
    mobile_number: phone.optional(),
    whatsapp_number: phone.optional(),
    address: trimmed(5, 500).optional(),
    emergency_contact: phone.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Nothing to update.' });

/**
 * Booking one or many seats. `seat_ids` is the real field; `seat_id` is still
 * accepted so an older client, or a link built by hand, keeps working.
 */
const seatIdList = z
  .array(z.coerce.number().int().positive())
  .min(1, 'Choose at least one seat.')
  .max(25, 'That is more than 25 seats in one booking.');

/** Accepts true/false, "true"/"false", 1/0 and "1"/"0". */
const booleanish = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1'),
  z.literal(1).transform(() => true),
  z.literal(0).transform(() => false),
]);

const createBookingSchema = z
  .object({
    concert_id: z.coerce.number().int().positive().optional(),
    seat_ids: z.union([seatIdList, z.coerce.number().int().positive()]).optional(),
    seat_id: z.coerce.number().int().positive().optional(),
  })
  .transform((data) => {
    const ids = data.seat_ids ?? data.seat_id;
    return {
      concert_id: data.concert_id ?? null,
      seat_ids: Array.isArray(ids) ? ids : ids === undefined ? [] : [ids],
    };
  })
  .refine((data) => data.seat_ids.length > 0, {
    message: 'Choose at least one seat.',
    path: ['seat_ids'],
  });

const concertSchema = z.object({
  name: trimmed(2, 190).optional(),
  description: z.string().trim().max(5000).nullish(),
  event_date: isoDate.optional(),
  start_time: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/)
    .optional(),
  end_time: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/)
    .nullish(),
  venue: trimmed(2, 190).optional(),
  address: z.string().trim().max(500).nullish(),
  max_capacity: z.coerce.number().int().min(1).max(100000).optional(),
  // 0 means no per-person limit: capacity is the only thing that stops them.
  max_seats_per_booking: z.coerce.number().int().min(0).max(1000).optional(),
  // Not z.coerce.boolean(): that turns the string "false" into true, so a form
  // posting is_active="false" would switch the concert on.
  is_active: booleanish.optional(),
  registration_opens_at: z.string().nullish(),
  registration_closes_at: z.string().nullish(),
  booking_opens_at: z.string().nullish(),
  booking_closes_at: z.string().nullish(),
  booking_ref_prefix: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{2,12}$/, 'Use 2-12 uppercase letters or digits.')
    .optional(),
});

/** Creating a concert needs the essentials; updating may be partial. */
const concertCreateSchema = concertSchema.required({
  name: true,
  event_date: true,
  start_time: true,
  venue: true,
});

const sectionSchema = z.object({
  name: trimmed(1, 60),
  display_order: z.coerce.number().int().min(0).max(9999).optional(),
});

const seatSchema = z.object({
  section_id: z.coerce.number().int().positive(),
  seat_number: trimmed(1, 16).transform((v) => v.toUpperCase()),
  row_label: z.string().trim().max(8).nullish(),
  display_order: z.coerce.number().int().min(0).max(9999).optional(),
  status: z.enum(['AVAILABLE', 'RESERVED', 'DISABLED']).optional(),
  note: z.string().trim().max(255).nullish(),
});

const seatUpdateSchema = seatSchema.partial().refine((d) => Object.keys(d).length > 0, {
  message: 'Nothing to update.',
});

const bulkSeatSchema = z.object({
  section_id: z.coerce.number().int().positive(),
  prefix: z
    .string()
    .trim()
    .max(8)
    .transform((v) => v.toUpperCase()),
  from: z.coerce.number().int().min(0).max(9999),
  to: z.coerce.number().int().min(0).max(9999),
  pad: z.coerce.number().int().min(1).max(4).optional(),
  row_label: z.string().trim().max(8).nullish(),
});

const adminUserUpdateSchema = z
  .object({
    is_active: z.boolean().optional(),
    disabled_reason: z.string().trim().max(255).nullish(),
    whatsapp_verified: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Nothing to update.' });

const adminBookingCreateSchema = z
  .object({
    user_id: z.coerce.number().int().positive(),
    concert_id: z.coerce.number().int().positive().optional(),
    seat_ids: z.union([seatIdList, z.coerce.number().int().positive()]).optional(),
    seat_id: z.coerce.number().int().positive().optional(),
    note: z.string().trim().max(255).nullish(),
  })
  .transform((data) => {
    const ids = data.seat_ids ?? data.seat_id;
    return {
      user_id: data.user_id,
      concert_id: data.concert_id ?? null,
      seat_ids: Array.isArray(ids) ? ids : ids === undefined ? [] : [ids],
      note: data.note ?? null,
    };
  })
  .refine((data) => data.seat_ids.length > 0, {
    message: 'Choose at least one seat.',
    path: ['seat_ids'],
  });

const adminBookingUpdateSchema = z.object({
  seat_id: z.coerce.number().int().positive(),
  note: z.string().trim().max(255).nullish(),
});

const cancelBookingSchema = z.object({
  reason: z.string().trim().max(255).nullish(),
});

const settingsSchema = z.object({
  duplicate_check_fields: z
    .array(z.enum(['email', 'mobile_number', 'whatsapp_number']))
    .min(1)
    .optional(),
  minimum_age: z.coerce.number().int().min(18).max(99).optional(),
  require_whatsapp_verification: z.boolean().optional(),
  allow_user_self_cancel: z.boolean().optional(),
});

/**
 * Validate `data` against `schema`, converting Zod errors into a 400 with a
 * field-keyed details object the frontend can render inline.
 */
function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const details = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!details[key]) details[key] = issue.message;
  }
  throw badRequest('Check the highlighted fields.', 'VALIDATION_FAILED', details);
}

module.exports = {
  parse,
  registerSchema,
  loginSchema,
  adminLoginSchema,
  verifyWhatsappSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  updateProfileSchema,
  createBookingSchema,
  concertSchema,
  concertCreateSchema,
  sectionSchema,
  seatSchema,
  seatUpdateSchema,
  bulkSeatSchema,
  adminUserUpdateSchema,
  adminBookingCreateSchema,
  adminBookingUpdateSchema,
  cancelBookingSchema,
  settingsSchema,
};
