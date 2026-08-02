import { z } from "zod";

/** Internal, process-separated admin channel used by the public Kernel CLI to ask the Warden owner. */
export const INTERNAL_EGRESS_EXCEPTION_ADMIN_ENV = "KEEL_INTERNAL_EGRESS_EXCEPTION_ADMIN";
export const EGRESS_EXCEPTION_ADMIN_REQUEST_B64_ENV =
  "KEEL_INTERNAL_EGRESS_EXCEPTION_ADMIN_REQUEST_B64";

export const EgressAddressExceptionContract = z
  .object({
    host: z.string().min(1).max(253),
    cidr: z.string().min(1).max(64),
    ports: z
      .array(z.number().int().min(1).max(65_535))
      .min(1)
      .max(64)
      .refine((ports) => new Set(ports).size === ports.length, "ports must be duplicate-free"),
  })
  .strict();

const Workspace = z.string().min(1).max(4_096);
const Revision = z.union([z.literal("none"), z.string().regex(/^sha256:[a-f0-9]{64}$/u)]);

export const EgressAddressExceptionAdminRequest = z.discriminatedUnion("operation", [
  z.object({ version: z.literal(1), operation: z.literal("list"), workspace: Workspace }).strict(),
  z
    .object({
      version: z.literal(1),
      operation: z.literal("add"),
      workspace: Workspace,
      exception: EgressAddressExceptionContract,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      operation: z.literal("remove"),
      workspace: Workspace,
      exception: EgressAddressExceptionContract,
    })
    .strict(),
]);

const ListResult = z
  .object({
    operation: z.literal("list"),
    workspaceRealpath: Workspace,
    revision: Revision,
    exceptions: z.array(EgressAddressExceptionContract).max(256),
  })
  .strict();

const MutationResult = z.union([
  z
    .object({
      operation: z.literal("add"),
      workspaceRealpath: Workspace,
      status: z.literal("added"),
      revision: Revision,
      durability: z.enum(["durable", "replaced"]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("add"),
      workspaceRealpath: Workspace,
      status: z.literal("already-present"),
      revision: Revision,
    })
    .strict(),
  z
    .object({
      operation: z.literal("remove"),
      workspaceRealpath: Workspace,
      status: z.literal("removed"),
      revision: Revision,
      durability: z.enum(["durable", "replaced"]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("remove"),
      workspaceRealpath: Workspace,
      status: z.literal("not-found"),
      revision: Revision,
    })
    .strict(),
]);

export const EgressAddressExceptionAdminResponse = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(1),
      ok: z.literal(true),
      result: z.union([ListResult, MutationResult]),
    })
    .strict(),
  z.object({ version: z.literal(1), ok: z.literal(false), error: z.string().max(480) }).strict(),
]);

export type EgressAddressExceptionContractT = z.infer<typeof EgressAddressExceptionContract>;
export type EgressAddressExceptionAdminRequestT = z.infer<
  typeof EgressAddressExceptionAdminRequest
>;
export type EgressAddressExceptionAdminResponseT = z.infer<
  typeof EgressAddressExceptionAdminResponse
>;
