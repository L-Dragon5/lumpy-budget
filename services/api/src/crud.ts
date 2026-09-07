import { Elysia, status } from "elysia";
import { byId, insert, remove, rows, update, type TableName } from "@lumpy/db";
import { z } from "zod";

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const notFound = () => status(404, { error: "not found" });

/**
 * The five routes every table gets. Written once and instantiated per resource,
 * so each call still declares a concrete path and Eden sees nine distinct route
 * sets rather than one `/:resource` it cannot type.
 *
 * `row` is passed for its type, not its runtime behaviour: it is what tells Eden
 * (and the web app) the shape that comes back. It is deliberately not used as a
 * `response` schema — MySQL hands `created_at` back as a Date, and validating
 * responses would turn a cosmetic contract gap into a 500.
 */
export function crud<const P extends string, RS extends z.ZodTypeAny>(
  path: P,
  table: TableName,
  input: z.ZodTypeAny,
  row: RS,
) {
  type Row = z.infer<RS>;
  void row;

  return new Elysia({ name: `crud:${path}` })
    .get(`/${path}`, () => rows<Row>(table))
    .get(`/${path}/:id`, async ({ params }) => (await byId<Row>(table, params.id)) ?? notFound(), {
      params: idParam,
    })
    .post(
      `/${path}`,
      async ({ body }) => {
        const id = await insert(table, body as Record<string, unknown>);
        return status(201, (await byId<Row>(table, id)) as Row);
      },
      { body: input },
    )
    .put(
      `/${path}/:id`,
      async ({ params, body }) => {
        if (!(await byId(table, params.id))) return notFound();
        await update(table, params.id, body as Record<string, unknown>);
        return (await byId<Row>(table, params.id)) as Row;
      },
      { params: idParam, body: input },
    )
    .delete(`/${path}/:id`, async ({ params }) => ((await remove(table, params.id)) ? { deleted: params.id } : notFound()), {
      params: idParam,
    });
}
