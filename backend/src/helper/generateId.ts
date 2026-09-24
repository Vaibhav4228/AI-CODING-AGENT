import { randomUUID } from "crypto";

export const generateId = (prefix: string = "thread"): string => {
  const uuid = randomUUID();
  return `${prefix}_${uuid.replace(/-/g, "")}`;
};
