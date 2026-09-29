import { z } from "zod";

// The "case file" Claude keeps up to date as the conversation goes on. It's
// shared between the server (tool schema + validation) and the client (panel).

export const RecommendedPartSchema = z.object({
  name: z.string().describe("Part name as listed on eSpares"),
  url: z.string().describe("eSpares product page URL"),
  price: z.string().optional().describe("Price as shown, e.g. £24.99"),
  partNumber: z.string().optional(),
  why: z.string().describe("One line on why this part matches the fault"),
});

export const CaseSchema = z.object({
  applianceType: z.string().optional().describe("e.g. washing machine, dishwasher, fridge freezer, oven"),
  brand: z.string().optional(),
  symptoms: z.string().optional().describe("Short plain-English summary of what's wrong"),
  likelyFaults: z
    .array(
      z.object({
        part: z.string().describe("Component that is probably at fault, e.g. drain pump"),
        likelihood: z.enum(["high", "medium", "low"]),
        reason: z.string(),
      }),
    )
    .optional(),
  modelNumber: z.string().optional().describe("Model number exactly as on the rating plate"),
  modelConfirmed: z
    .boolean()
    .optional()
    .describe("True only once the person has confirmed the exact model/variant matches their appliance"),
  modelPageUrl: z.string().optional().describe("eSpares model page URL for the confirmed model"),
  recommendedParts: z.array(RecommendedPartSchema).optional(),
});

export type RepairCase = z.infer<typeof CaseSchema>;
export type RecommendedPart = z.infer<typeof RecommendedPartSchema>;
