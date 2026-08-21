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

/**
 * Optional, and blank counts as absent.
 *
 * A plain `.optional()` is not enough: the browser posts every text field it
 * has, so an untouched input arrives as '' rather than going missing, and ''
 * then fails the inner rules (min length, phone format) instead of being
 * treated as "left empty". Anything actually typed is still validated in full.
 */
const optional = (schema) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.');

/** Accepts true/false, "true"/"false", 1/0 and "1"/"0". */
const booleanish = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1'),
  z.literal(1).transform(() => true),
  z.literal(0).transform(() => false),
]);

const registerSchema = z.object({
  full_name: trimmed(2, 120),
  email,
  mobile_number: phone,
  whatsapp_number: phone,
  password,
  date_of_birth: isoDate,
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']),
  // Optional. Nothing in booking, seating, check-in or the ticket reads either
  // of these, so requiring them only cost sign-ups.
  address: optional(trimmed(5, 500)),
  emergency_contact: optional(phone),
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
  // booleanish, not z.coerce.boolean(): an unchecked box posts "false", and
  // coerce would read that string as true.
  remember: booleanish.optional(),
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
    address: optional(trimmed(5, 500)),
    emergency_contact: optional(phone),
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

/**
 * Who is sitting in one seat.
 *
 * `seat_id` is carried on the guest rather than inferred from array position.
 * The booking service sorts seats into ascending id order before it locks them
 * — that ordering is what makes concurrent multi-seat requests deadlock-free —
 * so anything matched up by index would silently attach the wrong person to the
 * wrong seat as soon as the client sent seats out of order. Naming the seat
 * makes the pairing explicit and order-independent.
 *
 * Age is optional and capped at 17 nowhere: an adult may volunteer it. What
 * matters is that a minor's age can be recorded, and that leaving it blank is
 * allowed for everyone.
 */
const guestSchema = z.object({
  seat_id: z.coerce.number().int().positive(),
  name: trimmed(2, 120),
  email,
  phone,
  /* Blanks are normalised to null *before* any coercion. A union with
     z.coerce.number() first cannot do this: an empty field arrives as '' from a
     form, Number('') is 0, and 0 is a valid age — so "not given" would silently
     become "newborn". */
  age: z.preprocess(
    (value) => (value === '' || value === undefined ? null : value),
    z.coerce.number().int().min(0).max(120).nullable(),
  ),
});

const createBookingSchema = z
  .object({
    concert_id: z.coerce.number().int().positive().optional(),
    seat_ids: z.union([seatIdList, z.coerce.number().int().positive()]).optional(),
    seat_id: z.coerce.number().int().positive().optional(),
    guests: z.array(guestSchema).max(20).optional(),
  })
  .transform((data) => {
    const ids = data.seat_ids ?? data.seat_id;
    const seatIds = Array.isArray(ids) ? ids : ids === undefined ? [] : [ids];
    return {
      concert_id: data.concert_id ?? null,
      // Guests may stand in for seat_ids entirely, so a client that collected
      // details per seat does not have to send the same ids twice.
      seat_ids: seatIds.length ? seatIds : (data.guests || []).map((g) => g.seat_id),
      guests: data.guests ?? null,
    };
  })
  .refine((data) => data.seat_ids.length > 0, {
    message: 'Choose at least one seat.',
    path: ['seat_ids'],
  })
  .refine(
    (data) =>
      !data.guests ||
      (data.guests.length === data.seat_ids.length &&
        new Set(data.guests.map((g) => g.seat_id)).size === data.guests.length &&
        data.guests.every((g) => data.seat_ids.includes(g.seat_id))),
    {
      message: 'Give details for each seat, once per seat.',
      path: ['guests'],
    },
  );

const concertSchema = z.object({
  name: trimmed(2, 190).optional(),
  description: z.string().trim().max(5000).nullish(),
  // A path under /assets, never a URL. Uploads set this themselves through
  // /concerts/:id/poster; this entry is for picking one of the bundled posters,
  // so the pattern is deliberately narrow — no scheme, no traversal, no
  // anything the browser would fetch off-origin.
  poster_path: z
    .string()
    .trim()
    .regex(
      /^\/assets\/posters\/[A-Za-z0-9._/-]{1,180}\.(svg|png|jpg|jpeg|webp)$/,
      'Choose one of the bundled posters, or upload an image.',
    )
    .refine((value) => !value.includes('..'), 'Invalid poster path.')
    .nullish(),
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

/**
 * A new console login, created from Settings → Staff accounts.
 *
 * `role` excludes SUPER_ADMIN on purpose. Handing out the role that can create
 * and delete other accounts is not something to do through a form field on a
 * list screen; promoting somebody is a separate, deliberate PATCH.
 *
 * The password rule is the shared `password` above rather than a stricter one,
 * so the message a steward sees setting theirs matches what the sign-in page
 * and the reset flow tell everybody else. scripts/seed-admin.js still holds the
 * first account to twelve characters, since that one is created unattended and
 * is the account that can create all the others.
 */
const adminAccountCreateSchema = z.object({
  full_name: trimmed(2, 120),
  email,
  password,
  role: z.enum(['ADMIN', 'STAFF']).default('STAFF'),
});

/**
 * Changing an existing login. Every field optional, because the three things
 * this is used for — rename, re-role, enable/disable — arrive one at a time
 * from three different controls.
 *
 * Password is not here. Resetting somebody else's password is a distinct act
 * with a distinct consequence (it signs out every session they have), so it has
 * its own endpoint rather than hiding inside a general update.
 */
const adminAccountUpdateSchema = z
  .object({
    full_name: trimmed(2, 120).optional(),
    role: z.enum(['SUPER_ADMIN', 'ADMIN', 'STAFF']).optional(),
    is_active: booleanish.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Nothing to update.' });

/** A super admin setting somebody else's password. */
const adminPasswordResetSchema = z.object({
  new_password: password,
});

const adminBookingCreateSchema = z
  .object({
    user_id: z.coerce.number().int().positive(),
    concert_id: z.coerce.number().int().positive().optional(),
    seat_ids: z.union([seatIdList, z.coerce.number().int().positive()]).optional(),
    seat_id: z.coerce.number().int().positive().optional(),
    note: z.string().trim().max(255).nullish(),
    // Optional here, unlike the attendee flow: staff booking a seat over the
    // phone often have a name and nothing else, and refusing the booking until
    // they have an email address for a walk-in helps nobody. Whatever is given
    // is recorded; the rest falls back to the account holder.
    guests: z.array(guestSchema.partial({ email: true, phone: true })).max(20).optional(),
  })
  .transform((data) => {
    const ids = data.seat_ids ?? data.seat_id;
    const seatIds = Array.isArray(ids) ? ids : ids === undefined ? [] : [ids];
    return {
      user_id: data.user_id,
      concert_id: data.concert_id ?? null,
      seat_ids: seatIds.length ? seatIds : (data.guests || []).map((g) => g.seat_id),
      note: data.note ?? null,
      guests: data.guests ?? null,
    };
  })
  .refine((data) => data.seat_ids.length > 0, {
    message: 'Choose at least one seat.',
    path: ['seat_ids'],
  });

/** Correcting the guest on a seat that is already booked. */
const guestUpdateSchema = z
  .object({
    guest_name: trimmed(2, 120).optional(),
    guest_email: email.nullish(),
    guest_phone: phone.nullish(),
    guest_age: z.preprocess(
      (value) => (value === '' || value === undefined ? null : value),
      z.coerce.number().int().min(0).max(120).nullable(),
    ),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Nothing to update.' });

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
  guestSchema,
  guestUpdateSchema,
  concertSchema,
  concertCreateSchema,
  sectionSchema,
  seatSchema,
  seatUpdateSchema,
  bulkSeatSchema,
  adminUserUpdateSchema,
  adminAccountCreateSchema,
  adminAccountUpdateSchema,
  adminPasswordResetSchema,
  adminBookingCreateSchema,
  adminBookingUpdateSchema,
  cancelBookingSchema,
  settingsSchema,
};
