import { z } from "zod";

const martyResponseSchema = z
  .strictObject({
    text: z.string().trim().min(1).max(1_200),
    citationTurnIds: z.array(z.string().min(1)).max(12),
  })
  .refine(
    (response) =>
      new Set(response.citationTurnIds).size ===
      response.citationTurnIds.length,
    { message: "Assistant transcript citations must be unique." },
  );

export type MartyResponse = z.infer<typeof martyResponseSchema>;

export function parseMartyResponse(
  value: unknown,
  transcriptTurnIds: readonly string[],
): MartyResponse {
  const response = martyResponseSchema.parse(value);
  const transcriptOrder = new Map(
    transcriptTurnIds.map((turnId, index) => [turnId, index]),
  );
  let previousIndex = -1;
  for (const turnId of response.citationTurnIds) {
    const index = transcriptOrder.get(turnId);
    if (index === undefined || index <= previousIndex) {
      throw new Error("Assistant returned an invalid transcript citation.");
    }
    previousIndex = index;
  }
  return response;
}
