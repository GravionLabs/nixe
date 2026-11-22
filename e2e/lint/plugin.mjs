// An oxlint JS plugin (#401): the e2e tests wait on conditions, never on time.
const noWaitForTimeout = {
  meta: { type: "problem", docs: { description: "Disallow page.waitForTimeout" } },
  create(context) {
    return {
      MemberExpression(node) {
        const name = node.property?.name ?? node.property?.value;
        if (name === "waitForTimeout") {
          context.report({
            node,
            message: "Wait on a condition (expect, expect.poll, a locator), not on time.",
          });
        }
      },
    };
  },
};

export default {
  meta: { name: "nixe-e2e" },
  rules: { "no-wait-for-timeout": noWaitForTimeout },
};
