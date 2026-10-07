import { z } from 'zod';

export const phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +13125550123.');
const short = z.string().trim().max(200);
export const settingsSchema = z
  .object({
    openaiKey: z.string().max(500).optional(),
    elevenKey: z.string().max(500).optional(),
    voiceId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]*$/)
      .max(100)
      .optional(),
    twilioSid: z
      .string()
      .regex(/^(AC[a-fA-F0-9]{32})?$/)
      .optional(),
    twilioToken: z.string().max(500).optional(),
    fromNumber: phone.or(z.literal('')).optional(),
    publicUrl: z
      .string()
      .max(500)
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return (
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === '/'
          );
        } catch {
          return false;
        }
      }, 'Enter the root of a public HTTPS tunnel, e.g. https://your-tunnel.ngrok-free.app')
      .optional(),
    model: short.min(1).optional(),
    transcriptionModel: short.min(1).optional(),
    speechModel: short.min(1).optional(),
  })
  .strict();

export const callSchema = z
  .object({
    mode: z.enum(['demo', 'browser', 'phone']),
    company: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(10).max(6000),
    details: z.string().trim().max(6000).default(''),
    to: phone.or(z.literal('')).default(''),
    maxMinutes: z.number().int().min(1).max(60).default(45),
    confirmed: z.literal(true, { error: 'Confirm the brief before starting.' }),
  })
  .strict()
  .superRefine((call, ctx) => {
    if (call.mode === 'phone' && !phone.safeParse(call.to).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'A destination number is required for a phone call.',
      });
    }
  });

export const decisionSchema = z
  .object({
    action: z.enum(['speak', 'dtmf', 'wait', 'ask_user', 'finish']),
    text: z.string().max(2000),
    digits: z.string().regex(/^[0-9*#wW]{0,24}$/),
    summary: z.string().max(2000),
    outcome: z.enum(['unknown', 'completed', 'needs_user', 'unsuccessful']),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (['speak', 'ask_user'].includes(d.action) && !d.text.trim()) {
      ctx.addIssue({ code: 'custom', message: 'This action requires text.' });
    }
    if (d.action === 'dtmf' && !d.digits)
      ctx.addIssue({ code: 'custom', message: 'DTMF requires digits.' });
    if (d.action === 'finish' && !d.summary.trim())
      ctx.addIssue({ code: 'custom', message: 'Finishing requires a summary.' });
  });

export const textSchema = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
export const digitsSchema = z.object({ digits: z.string().regex(/^[0-9*#wW]{1,24}$/) }).strict();
