import { Hono } from "hono";
import { handleVehicles } from "./vehicles";
import { handleVehicleDetails } from "./vehicle-details";

const app = new Hono<{ Bindings: Env }>();

app.get("/v1/live/vehicles", (c) => handleVehicles(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.get("/v1/live/trips/:trip_id", (c) => handleVehicleDetails(c.req.raw, c.env, c.executionCtx as ExecutionContext));

export default app;
