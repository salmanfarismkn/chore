
export const allocationWeights = {
  rating: 100,
  completedJobs: 0.2,
};


export const allocationConfig = {
  tiers: [
    {
      name: "tier_1",
      candidateCount: 3,
      timeoutSeconds: 20,
    },
    {
      name: "tier_2",
      candidateCount: 5,
      timeoutSeconds: 20,
    },
    {
      name: "tier_3",
      candidateCount: 10,
      timeoutSeconds: 30,
    },
  ],
  noWorker: {
    action: "surge_or_escalation", // placeholder for escalation logic
  },
};
