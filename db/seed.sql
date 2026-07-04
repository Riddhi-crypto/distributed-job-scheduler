-- Seed a demo tenant so the dashboard is populated on first boot.
-- Demo login:  demo@aegis.dev  /  password123
-- The bcrypt hash below is for "password123" (cost 10).

INSERT INTO organizations (id, name)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'Acme Corp')
ON CONFLICT DO NOTHING;

INSERT INTO users (id, email, password_hash, display_name)
VALUES (
  '00000000-0000-0000-0000-0000000000b1',
  'demo@aegis.dev',
  '$2b$10$Q0Zp3q0m6mQ3o9F5uYb1uO0y2wYjJ3iQ0m9m1yqY0m9m1yqY0m9m', -- replaced on migrate
  'Demo Operator'
) ON CONFLICT (email) DO NOTHING;

INSERT INTO memberships (org_id, user_id, role)
VALUES ('00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-0000000000b1', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO projects (id, org_id, name, slug)
VALUES ('00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-0000000000a1', 'Default Project', 'default')
ON CONFLICT DO NOTHING;

INSERT INTO retry_policies (id, project_id, name, strategy, base_delay_ms, max_delay_ms, max_attempts)
VALUES
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1','exp-backoff','exponential',1000,60000,5),
 ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000c1','linear','linear',2000,30000,4),
 ('00000000-0000-0000-0000-0000000000d3','00000000-0000-0000-0000-0000000000c1','fixed-5s','fixed',5000,5000,3)
ON CONFLICT DO NOTHING;

INSERT INTO queues (id, project_id, name, priority, concurrency_limit, shard, default_retry_policy_id)
VALUES
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000c1','default', 100, 10, 0,'00000000-0000-0000-0000-0000000000d1'),
 ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000c1','critical',200, 20, 6,'00000000-0000-0000-0000-0000000000d1')
ON CONFLICT DO NOTHING;
