import { sql } from 'drizzle-orm';
import { getConfig } from '@/shared/config/index.js';
import { createLogger } from '@/shared/logging/index.js';
import { createDatabase } from '@/shared/database/pool.js';
import { hashPassword } from '@/shared/security/password.js';

/**
 * Demo data.
 *
 * Idempotent by construction (`ON CONFLICT DO NOTHING` / guarded inserts) so it can be run
 * repeatedly against a running stack without duplicating anyone or failing a deploy.
 *
 * The seeded accounts are demo credentials for a take-home environment. They are printed
 * once on completion and nowhere else, and the password is intentionally a well-known
 * placeholder rather than something that looks production-plausible.
 */

const DEMO_PASSWORD = 'Careflow!2026';

interface SeedTherapist {
  readonly email: string;
  readonly fullName: string;
  readonly displayName: string;
  readonly specialization: string;
  /** ISO weekday (1 = Monday) -> [start, end] wall-clock in APP_TIMEZONE. */
  readonly schedule: readonly { day: number; start: string; end: string }[];
}

const THERAPISTS: readonly SeedTherapist[] = [
  {
    email: 'dr.mehta@careflow.test',
    fullName: 'Dr. Anjali Mehta',
    displayName: 'Dr. Anjali Mehta',
    specialization: 'Cognitive Behavioural Therapy',
    schedule: [
      { day: 1, start: '09:00', end: '13:00' },
      { day: 1, start: '14:00', end: '18:00' },
      { day: 2, start: '09:00', end: '13:00' },
      { day: 3, start: '10:00', end: '17:00' },
      { day: 4, start: '09:00', end: '13:00' },
      { day: 5, start: '09:00', end: '15:00' },
    ],
  },
  {
    email: 'dr.rao@careflow.test',
    fullName: 'Dr. Vikram Rao',
    displayName: 'Dr. Vikram Rao',
    specialization: 'Family and Couples Therapy',
    schedule: [
      { day: 1, start: '11:00', end: '19:00' },
      { day: 3, start: '11:00', end: '19:00' },
      { day: 5, start: '11:00', end: '16:00' },
      // Weekend clinic, to give the availability tests a non-weekday case.
      { day: 6, start: '10:00', end: '14:00' },
    ],
  },
  {
    email: 'dr.iyer@careflow.test',
    fullName: 'Dr. Priya Iyer',
    displayName: 'Dr. Priya Iyer',
    specialization: 'Trauma and EMDR',
    schedule: [
      { day: 2, start: '08:00', end: '12:00' },
      { day: 4, start: '08:00', end: '12:00' },
      { day: 4, start: '13:00', end: '17:00' },
    ],
  },
];

const PATIENTS = [
  { email: 'patient@careflow.test', fullName: 'Rohan Sharma' },
  { email: 'patient2@careflow.test', fullName: 'Meera Nair' },
  { email: 'patient3@careflow.test', fullName: 'Arjun Desai' },
] as const;

export const runSeed = async (): Promise<void> => {
  const config = getConfig();
  const logger = createLogger(config).child({ component: 'seed' });
  const database = createDatabase(config, logger);
  const { db } = database;

  try {
    // One hash for all demo accounts: Argon2id is intentionally expensive, and hashing the
    // same placeholder six times would add seconds to every stack start for no benefit.
    const passwordHash = await hashPassword(DEMO_PASSWORD);

    // Schedules take effect from the start of the current month so that "this week" is
    // always inside an effective window, whenever the seed happens to run.
    const effectiveFrom = new Date();
    effectiveFrom.setUTCDate(1);
    const effectiveFromDate = effectiveFrom.toISOString().slice(0, 10);

    for (const therapist of THERAPISTS) {
      const userResult = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, password_hash, role, full_name)
        VALUES (${therapist.email}, ${passwordHash}, 'THERAPIST', ${therapist.fullName})
        ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
        RETURNING id
      `);

      const userId = userResult.rows[0]?.id;
      if (!userId) throw new Error(`Failed to upsert therapist user ${therapist.email}`);

      const therapistResult = await db.execute<{ id: string }>(sql`
        INSERT INTO therapists (user_id, display_name, specialization)
        VALUES (${userId}::uuid, ${therapist.displayName}, ${therapist.specialization})
        ON CONFLICT (user_id) DO UPDATE
          SET display_name = EXCLUDED.display_name,
              specialization = EXCLUDED.specialization
        RETURNING id
      `);

      const therapistId = therapistResult.rows[0]?.id;
      if (!therapistId) throw new Error(`Failed to upsert therapist ${therapist.email}`);

      for (const rule of therapist.schedule) {
        // The exclusion constraint already rejects an overlapping duplicate, but checking
        // first keeps re-running the seed quiet instead of noisy-but-harmless.
        await db.execute(sql`
          INSERT INTO therapist_schedules (therapist_id, day_of_week, start_time, end_time, effective_from)
          SELECT ${therapistId}::uuid, ${rule.day}, ${rule.start}::time, ${rule.end}::time, ${effectiveFromDate}::date
           WHERE NOT EXISTS (
             SELECT 1 FROM therapist_schedules
              WHERE therapist_id = ${therapistId}::uuid
                AND day_of_week = ${rule.day}
                AND start_time = ${rule.start}::time
                AND effective_until IS NULL
           )
        `);
      }
    }

    for (const patient of PATIENTS) {
      await db.execute(sql`
        INSERT INTO users (email, password_hash, role, full_name)
        VALUES (${patient.email}, ${passwordHash}, 'PATIENT', ${patient.fullName})
        ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
      `);
    }

    const counts = await db.execute<{ therapists: string; patients: string; rules: string }>(sql`
      SELECT (SELECT count(*)::text FROM therapists) AS therapists,
             (SELECT count(*)::text FROM users WHERE role = 'PATIENT') AS patients,
             (SELECT count(*)::text FROM therapist_schedules) AS rules
    `);

    logger.info({ ...counts.rows[0], effectiveFrom: effectiveFromDate }, 'seed complete');

    // Printed rather than logged so the credentials are visible when starting the stack but
    // are not swept into structured log storage.
    process.stdout.write(
      [
        '',
        '  Demo accounts (all share the same password)',
        `  password: ${DEMO_PASSWORD}`,
        ...THERAPISTS.map((t) => `  therapist: ${t.email}`),
        ...PATIENTS.map((p) => `  patient:   ${p.email}`),
        '',
      ].join('\n'),
    );
  } finally {
    await database.close();
  }
};

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');

if (isEntrypoint) {
  runSeed()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
