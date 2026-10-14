import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { releaseProcessedTicketAgent } from "../server/agent-availability";

// Disposable local DB only; never uses the application's DATABASE_URL.
describe.skipIf(!process.env.AVAILABILITY_TEST_SOCKET)("availability SQL", () => {
  const pool = new Pool({host:process.env.AVAILABILITY_TEST_SOCKET, port:55441, user:"availability_test",database:"availability_test"});
  beforeAll(async () => {
    await pool.query(`CREATE TABLE users(id int PRIMARY KEY,name text,role text,is_active boolean,agent_status text,updated_at timestamp);
      CREATE TABLE submissions(id int PRIMARY KEY,assigned_to int,ticket_status text)`);
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE users,submissions;
      INSERT INTO users VALUES (44,'Agent','vrs_agent',true,'working',now());
      INSERT INTO submissions VALUES (1,44,'completed')`);
  });
  afterAll(async () => {await pool.end()});
  it("releases an agent with only a completed ticket", async () => {
    expect(await releaseProcessedTicketAgent(pool,44,1)).toEqual({id:44,name:"Agent"});
  });
  it("does not release an agent with another pending ticket", async () => {
    await pool.query("INSERT INTO submissions VALUES (2,44,'pending')");
    expect(await releaseProcessedTicketAgent(pool,44,1)).toBeNull();
    expect((await pool.query("SELECT agent_status FROM users")).rows[0].agent_status).toBe("working");
  });
  it("ignores other agents' tickets and old completed tickets", async () => {
    await pool.query("INSERT INTO submissions VALUES (2,55,'pending'),(3,44,'completed')");
    expect(await releaseProcessedTicketAgent(pool,44,1)).not.toBeNull();
  });
  it("preserves stage-one release when the processed ticket stays pending", async () => {
    await pool.query("UPDATE submissions SET ticket_status='pending' WHERE id=1");
    expect(await releaseProcessedTicketAgent(pool,44,1)).not.toBeNull();
  });
  it.each(["offline","online"])("does not override %s", async status => {
    await pool.query("UPDATE users SET agent_status=$1",[status]);
    expect(await releaseProcessedTicketAgent(pool,44,1)).toBeNull();
  });
  it("does not activate disabled accounts", async () => {
    await pool.query("UPDATE users SET is_active=false");
    expect(await releaseProcessedTicketAgent(pool,44,1)).toBeNull();
  });
});
