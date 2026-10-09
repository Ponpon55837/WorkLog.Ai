import { z } from "zod";
export const relatedWorkQuerySchema = z.object({ sessionId: z.string().min(1).max(300) }).strict();
