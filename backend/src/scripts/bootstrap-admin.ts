import { AdminBootstrapService } from "../modules/admin-bootstrap/admin-bootstrap.service";
import { db } from "../db";

const parseUserId = (value: string | undefined) => {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const userId = Number(value);
  return Number.isSafeInteger(userId) ? userId : null;
};

export const runAdminBootstrapCommand = async (
  args: string[],
  providedSecret: string | undefined,
  service = new AdminBootstrapService(),
) => {
  const userId = parseUserId(args[0]);
  if (userId === null) {
    console.error(
      "Usage: pnpm exec tsx src/scripts/bootstrap-admin.ts <local-user-id>",
    );
    return 2;
  }

  try {
    const result = await service.provision(userId, providedSecret);
    console.info(
      `Initial administrator provisioned for local user ${result.userId}.`,
    );
    return 0;
  } catch {
    console.error(
      "Administrator bootstrap failed; no credentials were logged.",
    );
    return 1;
  }
};

const run = async () => {
  try {
    process.exitCode = await runAdminBootstrapCommand(
      process.argv.slice(2),
      process.env.ADMIN_BOOTSTRAP_SECRET,
    );
  } finally {
    await db.$client.end();
  }
};

if (
  process.argv[1]
    ?.replaceAll("\\", "/")
    .endsWith("/src/scripts/bootstrap-admin.ts")
) {
  void run();
}
