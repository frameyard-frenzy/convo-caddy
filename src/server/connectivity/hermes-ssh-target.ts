import { z } from "zod";

export const hermesSshTargetSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
    "SSH target must use host or user@host syntax.",
  );

export function isHermesSshTarget(value: string): boolean {
  return hermesSshTargetSchema.safeParse(value).success;
}
