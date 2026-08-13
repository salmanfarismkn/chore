export const allocationWeights = {
  rating: 100,
  completedJobs: 0.2,
};

export const allocationTiers = {
  tier1: {
    candidateCount: 3,
    timeoutSeconds: 20,
  },
  tier2: {
    candidateCount: 5,
    timeoutSeconds: 20,
  },
  tier3: {
    candidateCount: 10,
    timeoutSeconds: 30,
  },
  noWorker: {
    action: "surge_or_escalation", // placeholder for escalation logic
  },
};