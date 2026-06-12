import { prisma } from "../db.js";
import { schedulePost, SchedulePostInput } from "./posts.js";

function badRequest(message: string): never {
  const err = new Error(message);
  (err as any).statusCode = 400;
  throw err;
}

// ---- Slot management (recurring weekly posting times) ----

export async function listSlots(accountId: string) {
  return prisma.queueSlot.findMany({
    where: { accountId },
    orderBy: [{ dayOfWeek: "asc" }, { hour: "asc" }, { minute: "asc" }],
  });
}

export async function addSlot(params: {
  accountId: string;
  dayOfWeek: number;
  hour: number;
  minute?: number;
}) {
  if (params.dayOfWeek < 0 || params.dayOfWeek > 6) badRequest("dayOfWeek must be 0..6 (0=Sunday)");
  if (params.hour < 0 || params.hour > 23) badRequest("hour must be 0..23");
  const minute = params.minute ?? 0;
  if (minute < 0 || minute > 59) badRequest("minute must be 0..59");
  return prisma.queueSlot.create({
    data: { accountId: params.accountId, dayOfWeek: params.dayOfWeek, hour: params.hour, minute },
  });
}

export async function deleteSlot(id: string) {
  return prisma.queueSlot.delete({ where: { id } });
}

/**
 * Compute the next free posting time for an account, based on its recurring
 * slots and the posts already queued (so queued posts stack chronologically).
 * Slots are interpreted in the server's local time.
 */
export async function nextQueueTime(accountId: string): Promise<Date> {
  const slots = await prisma.queueSlot.findMany({ where: { accountId } });
  if (!slots.length) badRequest("No queue slots configured for this account");

  const now = new Date();
  const lastPending = await prisma.scheduledPost.findFirst({
    where: { accountId, status: "PENDING" },
    orderBy: { scheduledAt: "desc" },
  });
  // Cursor: stack after the latest already-queued post, but never in the past.
  const cursor =
    lastPending && lastPending.scheduledAt > now ? lastPending.scheduledAt : now;

  for (let d = 0; d < 90; d++) {
    const day = new Date(now);
    day.setDate(now.getDate() + d);
    const dow = day.getDay();
    const daySlots = slots
      .filter((s) => s.dayOfWeek === dow)
      .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
    for (const s of daySlots) {
      const candidate = new Date(day);
      candidate.setHours(s.hour, s.minute, 0, 0);
      if (candidate > cursor) return candidate;
    }
  }
  badRequest("No available slot found in the next 90 days");
}

/** Add a post to the account's queue (auto-assigns the next free slot). */
export async function addToQueue(input: Omit<SchedulePostInput, "scheduledAt">) {
  const when = await nextQueueTime(input.accountId);
  return schedulePost({ ...input, scheduledAt: when.toISOString() });
}
