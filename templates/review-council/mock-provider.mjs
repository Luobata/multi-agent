let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const role = process.argv[2];
const specialist = {
  "product-manager": {
    verdict: "Pass",
    summary: "The requirement has a bounded user outcome and observable acceptance path.",
    evidence: ["The request identifies both the reviewer and the resume outcome."],
    risks: ["Real product evidence should replace the mock provider before release."]
  },
  designer: {
    verdict: "Pass",
    summary: "The intended resume action has a clear runtime target.",
    evidence: ["The workflow supplies a running-page URL for direct observation."],
    risks: ["The mock does not perform a real browser measurement."]
  },
  tester: {
    verdict: "Pass",
    summary: "The behavior is expressed as a reproducible resume scenario.",
    evidence: ["The workflow supplies requirement, change, and runtime context."],
    risks: ["The mock does not execute the real E2E suite."]
  }
};

const output = role === "chair"
  ? {
      verdict: prompt.includes('"verdict": "Block"') ? "Block" : "Pass",
      summary: "The independent product, design, and test evidence is mutually consistent.",
      agreements: ["All reviewers identify a bounded resume-review path."],
      disagreements: [],
      nextActions: ["Replace the mock provider with a sandboxed model adapter for real acceptance."]
    }
  : specialist[role];

if (!output) {
  process.stderr.write(`Unknown mock role: ${role}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify(output)}\n`);
