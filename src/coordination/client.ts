import { Redis } from "ioredis";
import { resolveCoordinationConfig } from "./utils.js";
import { createCoordinationKeyBuilder } from "./utils.js";
import type { CoordinationClientConfig } from "./types.js";
import type { Logger } from "../logger.js";
import { createLockManager } from "./lock.js";
import { createSemaphoreManager } from "./semaphore.js";
import { createSingleFlightManager } from "./single-flight.js";
import { LeaderElectionCoordinator } from "./leader-election.js";
import { createJobClaimManager } from "./job-claim.js";
import { createResourceLeaseManager } from "./resource-lease.js";
import { createBarrierCoordinator } from "./barrier.js";
import type {
  LockAcquireOptions,
  LockAcquireResult,
  LockTryOptions,
  LockRenewOptions,
  LockReleaseOptions,
  LockStatus,
  LockRenewResult,
  LockReleaseResult,
  WithLockResult,
  SemaphoreAcquireOptions,
  SemaphoreAcquireResult,
  SemaphoreTryOptions,
  SemaphoreRenewOptions,
  SemaphoreReleaseOptions,
  SemaphoreReleaseResult,
  SemaphoreStatus,
  SingleFlightOptions,
  SingleFlightResult,
  LeaderElectionOptions,
  LeaderElectionStatus,
  LeaderElectionEvent,
  JobClaimOptions,
  JobClaimResult,
  JobCompleteOptions,
  JobReleaseOptions,
  JobClaimStatus,
  LeaseAcquireOptions,
  LeaseRenewOptions,
  LeaseReleaseOptions,
  LeaseResult,
  LeaseStatus,
  BarrierArrivalOptions,
  BarrierArrivalResult,
  BarrierStatus,
} from "./types.js";

interface LockHandle {
  token: string;
  fencingToken: number;
  resource: string;
  leaseLost: () => boolean;
  signal: AbortSignal;
}

export interface CoordinationClient {
  readonly client: Redis;
  readonly keyBuilder: ReturnType<typeof createCoordinationKeyBuilder>;
  readonly config: ReturnType<typeof resolveCoordinationConfig>;

  // Locks
  acquireLock: (opts: LockAcquireOptions) => Promise<LockAcquireResult>;
  tryLock: (opts: LockTryOptions) => Promise<LockAcquireResult>;
  renewLock: (opts: LockRenewOptions) => Promise<LockRenewResult>;
  releaseLock: (opts: LockReleaseOptions) => Promise<LockReleaseResult>;
  withLock: <T>(
    resourceOrOptions: string | LockAcquireOptions,
    leaseMsOrCallback: number | ((handle: LockHandle) => T | Promise<T>),
    callbackOrOptions?: ((handle: LockHandle) => T | Promise<T>) | Record<string, unknown>,
    optionsArg?: Record<string, unknown>,
  ) => Promise<WithLockResult<T>>;
  getLockStatus: (resource: string) => Promise<LockStatus>;

  // Semaphore
  acquireSemaphore: (opts: SemaphoreAcquireOptions) => Promise<SemaphoreAcquireResult>;
  tryAcquireSemaphore: (opts: SemaphoreTryOptions) => Promise<SemaphoreAcquireResult>;
  renewSemaphore: (opts: SemaphoreRenewOptions) => Promise<{ renewed: boolean; ttlMs?: number; error?: string }>;
  releaseSemaphore: (opts: SemaphoreReleaseOptions) => Promise<SemaphoreReleaseResult>;
  getSemaphoreStatus: (resource: string, permits: number) => Promise<SemaphoreStatus>;

  // Single flight
  singleFlight: <T>(opts: SingleFlightOptions<T>) => Promise<SingleFlightResult<T>>;

  // Leader election
  createLeaderElection: (opts: LeaderElectionOptions) => LeaderElectionCoordinator;

  // Job claims
  claimJob: (opts: JobClaimOptions) => Promise<JobClaimResult>;
  renewJobClaim: (opts: { jobId: string; token: string; leaseMs: number }) => Promise<{ renewed: boolean; ttlMs?: number; error?: string }>;
  releaseJobClaim: (opts: JobReleaseOptions) => Promise<{ released: boolean; error?: string }>;
  completeJobClaim: (opts: JobCompleteOptions) => Promise<{ completed: boolean; error?: string }>;
  failJobClaim: (opts: { jobId: string; token: string; error?: string }) => Promise<{ failed: boolean; error?: string }>;
  getJobClaimStatus: (jobId: string) => Promise<JobClaimStatus>;

  // Resource leases
  acquireLease: (opts: LeaseAcquireOptions) => Promise<LeaseResult>;
  renewLease: (opts: LeaseRenewOptions) => Promise<{ renewed: boolean; error?: string; ttlMs?: number }>;
  releaseLease: (opts: LeaseReleaseOptions) => Promise<{ released: boolean; error?: string }>;
  getLeaseStatus: (resource: string) => Promise<LeaseStatus>;

  // Barriers
  arriveBarrier: (opts: BarrierArrivalOptions) => Promise<BarrierArrivalResult>;
  getBarrierStatus: (barrierId: string, generation: number) => Promise<BarrierStatus>;
}

export function createCoordinationClient(config: CoordinationClientConfig): CoordinationClient {
  const resolved = resolveCoordinationConfig(config);
  const client = resolved.client;
  const keyBuilder = resolved.keyBuilder;

  const lockManager = createLockManager({
    client,
    keyBuilder,
    defaultLeaseMs: resolved.defaultLeaseMs,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });

  const semaphoreManager = createSemaphoreManager({
    client,
    keyBuilder,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });

  const singleFlightManager = createSingleFlightManager({
    client,
    keyBuilder,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });

  const jobClaimManager = createJobClaimManager({
    client,
    keyBuilder,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });

  const leaseManager = createResourceLeaseManager({
    client,
    keyBuilder,
    defaultLeaseMs: resolved.defaultLeaseMs,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });

  const barrierCoordinator = createBarrierCoordinator({
    client,
    keyBuilder,
    logger: resolved.logger,
  });

  return {
    client,
    keyBuilder,
    config: resolved,
    acquireLock: (opts: LockAcquireOptions) => lockManager.acquireLock(opts),
    tryLock: (opts: LockTryOptions) => lockManager.tryLock(opts),
    renewLock: (opts: LockRenewOptions) => lockManager.renewLock(opts),
    releaseLock: (opts: LockReleaseOptions) => lockManager.releaseLock(opts),
    withLock: <T>(
      resourceOrOptions: string | LockAcquireOptions,
      leaseMsOrCallback: number | ((handle: LockHandle) => T | Promise<T>),
      callbackOrOptions?: ((handle: LockHandle) => T | Promise<T>) | Record<string, unknown>,
      optionsArg?: Record<string, unknown>,
    ) => lockManager.withLock(resourceOrOptions, leaseMsOrCallback, callbackOrOptions, optionsArg),
    getLockStatus: (resource: string) => lockManager.getLockStatus(resource),
    acquireSemaphore: (opts: SemaphoreAcquireOptions) => semaphoreManager.acquire(opts),
    tryAcquireSemaphore: (opts: SemaphoreTryOptions) => semaphoreManager.tryAcquire(opts),
    renewSemaphore: (opts: SemaphoreRenewOptions) => semaphoreManager.renew(opts),
    releaseSemaphore: (opts: SemaphoreReleaseOptions) => semaphoreManager.release(opts),
    getSemaphoreStatus: (resource: string, permits: number) => semaphoreManager.getStatus(resource, permits),
    singleFlight: <T>(opts: SingleFlightOptions<T>) => singleFlightManager.execute(opts),
    createLeaderElection: (opts: LeaderElectionOptions) =>
      new LeaderElectionCoordinator(client, keyBuilder, opts, resolved.logger),
    claimJob: (opts: JobClaimOptions) => jobClaimManager.claim(opts),
    renewJobClaim: (opts: { jobId: string; token: string; leaseMs: number }) => jobClaimManager.renew(opts),
    releaseJobClaim: (opts: JobReleaseOptions) => jobClaimManager.release(opts),
    completeJobClaim: (opts: JobCompleteOptions) => jobClaimManager.complete(opts),
    failJobClaim: (opts: { jobId: string; token: string; error?: string }) => jobClaimManager.fail(opts),
    getJobClaimStatus: (jobId: string) => jobClaimManager.getStatus(jobId),
    acquireLease: (opts: LeaseAcquireOptions) => leaseManager.acquire(opts),
    renewLease: (opts: LeaseRenewOptions) => leaseManager.renew(opts),
    releaseLease: (opts: LeaseReleaseOptions) => leaseManager.release(opts),
    getLeaseStatus: (resource: string) => leaseManager.getStatus(resource),
    arriveBarrier: (opts: BarrierArrivalOptions) => barrierCoordinator.arrive(opts),
    getBarrierStatus: (barrierId: string, generation: number) => barrierCoordinator.getStatus(barrierId, generation),
  };
}
