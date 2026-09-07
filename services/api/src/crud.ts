import { Elysia, status } from "elysia";
import { byId, insert, remove, rows, update, type TableName } from "@lumpy/db";
import { z } from "zod";

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const errorBody = z.object({ error: z.string() });
export const deleted = z.object({ deleted: z.number().int() });
export const notFound = () => status(404, { error: "not found" });

/**
 * The five routes every table gets. Written once and instantiated per resource,
 * so each call still declares a concrete path and Eden sees nine distinct route
 * sets rather than one `/:resource` it cannot type.
 *
 * `row` is both the type the web app receives and the schema every response is
 * checked against, so a column the contract does not describe fails a test here
 * instead of reaching the client unannounced.
 */
export function crud<const P extends string, RS extends z.ZodTypeAny>(
  path: P,
  table: TableName,
  input: z.ZodTypeAny,
  row: RS,
) {
  type Row = z.infer<RS>;

  return new Elysia({ name: `crud:${path}` })
    .get(`/${path}`, () => rows<Row>(table), { response: z.array(row) })
    .get(`/${path}/:id`, async ({ params }) => (await byId<Row>(table, params.id)) ?? notFound(), {
      params: idParam,
      response: { 200: row, 404: errorBody },
    })
    .post(
      `/${path}`,
      async ({ body }) => {
        const id = await insert(table, body as Record<string, unknown>);
        return status(201, (await byId<Row>(table, id)) as Row);
      },
      { body: input, response: { 201: row } },
    )
    .put(
      `/${path}/:id`,
      async ({ params, body }) => {
        if (!(await byId(table, params.id))) return notFound();
        await update(table, params.id, body as Record<string, unknown>);
        return (await byId<Row>(table, params.id)) as Row;
      },
      { params: idParam, body: input, response: { 200: row, 404: errorBody } },
    )
    .delete(`/${path}/:id`, async ({ params }) => ((await remove(table, params.id)) ? { deleted: params.id } : notFound()), {
      params: idParam,
      response: { 200: deleted, 404: errorBody },
    });
}
