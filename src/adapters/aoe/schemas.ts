import { z } from "zod";

const worktreeSchema = z
  .object({
    branch: z.string(),
    main_repo_path: z.string(),
    managed_by_aoe: z.boolean().optional(),
  })
  .passthrough();

export const aoeListEntrySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    path: z.string(),
    group: z.string().default(""),
    tool: z.string(),
    command: z.string().optional(),
    profile: z.string(),
    created_at: z.string().optional(),
    workspace_repos: z.array(z.unknown()).optional(),
    worktree: worktreeSchema.optional(),
  })
  .passthrough();

export type AoeListEntry = z.infer<typeof aoeListEntrySchema>;

export const aoeListSchema = z.array(aoeListEntrySchema);

const statusSchema = z.enum([
  "waiting",
  "running",
  "idle",
  "stopped",
  "error",
]);

export const aoeSessionShowSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    path: z.string(),
    group: z.string().default(""),
    tool: z.string(),
    command: z.string().optional(),
    status: statusSchema,
    profile: z.string(),
  })
  .passthrough();

export type AoeSessionShow = z.infer<typeof aoeSessionShowSchema>;

export const aoeCaptureSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: statusSchema,
    tool: z.string(),
    content: z.string(),
    lines: z.number(),
  })
  .passthrough();

export type AoeCapture = z.infer<typeof aoeCaptureSchema>;

export const aoeStatusSchema = z.object({
  waiting: z.number(),
  running: z.number(),
  idle: z.number(),
  stopped: z.number(),
  error: z.number(),
  total: z.number(),
});

export type AoeStatusAggregate = z.infer<typeof aoeStatusSchema>;
