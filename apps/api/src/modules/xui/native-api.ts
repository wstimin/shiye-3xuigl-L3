import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import type { XuiClient } from "@shiye/xui-client";

type Row = Record<string, any>;
export const nativeExecuteSchema = z.object({
  operation: z.string().max(300),
  parameters: z
    .record(z.union([z.string().max(4000), z.number().finite(), z.boolean()]))
    .default({}),
  body: z.unknown().optional(),
  confirmed: z.boolean().default(false),
  file: z
    .object({
      field: z.string().max(80),
      name: z.string().max(200),
      type: z.string().max(120),
      base64: z
        .string()
        .max(22_400_000)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    })
    .optional(),
});

const readPosts =
  /\/(lastOnline|onlines|onlinesByGuid|clientIpsByGuid|activeInbounds|ips|traffic|allTraffics|logs|xraylogs|xray|balancerStatus|routeTest|testOutbound|testOutbounds|validateRegex|tgBotCapabilities|testSmtp|testTgBot|testDiscord|parse|renewalPreview)\/?$/;
const readSettings = new Set([
  "/panel/api/setting/all",
  "/panel/api/setting/defaultSettings",
]);
export function nativeCatalog(document: Row) {
  const resolve = (schema: Row = {}, depth = 0): Row => {
    if (depth > 7) return {};
    if (schema.$ref) {
      const target = String(schema.$ref)
        .split("/")
        .slice(1)
        .reduce((value: any, key: string) => value?.[key], document);
      return resolve(target || {}, depth + 1);
    }
    return {
      type: schema.type,
      enum: schema.enum,
      default: schema.default,
      example: schema.example,
      format: schema.format,
      description: schema.description,
      required: schema.required,
      ...(schema.properties
        ? {
            properties: Object.fromEntries(
              Object.entries(schema.properties).map(([key, value]) => [
                key,
                resolve(value as Row, depth + 1),
              ]),
            ),
          }
        : {}),
      ...(schema.items ? { items: resolve(schema.items, depth + 1) } : {}),
      ...Object.fromEntries(
        ["oneOf", "anyOf", "allOf"]
          .filter((key) => Array.isArray(schema[key]))
          .map((key) => [
            key,
            schema[key].map((item: Row) => resolve(item, depth + 1)),
          ]),
      ),
    };
  };
  return Object.entries(document.paths || {}).flatMap(([path, value]) => {
    if (!path.startsWith("/panel/api/") || /[?#\\]|\.\./.test(path)) return [];
    return Object.entries(value as Row)
      .filter(([method]) =>
        ["get", "post", "put", "patch", "delete"].includes(method),
      )
      .map(([method, operation]) => {
        const item = operation as Row;
        const encoding = Object.keys(item.requestBody?.content || {})[0];
        return {
          id: `${method.toUpperCase()} ${path}`,
          path,
          method: method.toUpperCase(),
          group: item.tags?.[0] || path.split("/")[3],
          summary: String(item.summary || item.operationId || path),
          parameters: [
            ...((value as Row).parameters || []),
            ...(item.parameters || []),
          ].map(
            (field: Row): Row => ({ ...field, schema: resolve(field.schema) }),
          ),
          encoding,
          schema: resolve(item.requestBody?.content?.[encoding || ""]?.schema),
          example: item.requestBody?.content?.[encoding || ""]?.example,
          mutates:
            method !== "get" &&
            !readPosts.test(path.replace(/\/\{[^}]+\}/g, "")) &&
            !readSettings.has(path),
        };
      });
  });
}

export async function executeNative(
  client: XuiClient,
  catalog: ReturnType<typeof nativeCatalog>,
  input: z.infer<typeof nativeExecuteSchema>,
  beforeRequest?: () => Promise<void>,
) {
  const operation = catalog.find((item) => item.id === input.operation);
  if (!operation)
    throw new BadRequestException("该面板未声明此 API 操作，请刷新能力列表");
  if (operation.mutates && !input.confirmed)
    throw new BadRequestException("请先确认远端写操作");
  if (
    operation.encoding &&
    operation.encoding !== "application/json" &&
    input.body !== undefined &&
    (!input.body || typeof input.body !== "object" || Array.isArray(input.body))
  )
    throw new BadRequestException("表单请求体必须为 JSON 对象");
  const allowed = new Set(operation.parameters.map((field: Row) => field.name));
  if (Object.keys(input.parameters).some((key) => !allowed.has(key)))
    throw new BadRequestException("包含接口未声明的参数");
  let path = operation.path;
  const query = new URLSearchParams();
  for (const field of operation.parameters) {
    const value = input.parameters[field.name];
    if ((value === undefined || value === "") && field.required)
      throw new BadRequestException(`缺少参数 ${field.name}`);
    if (value === undefined || value === "") continue;
    if (field.in === "path") {
      if (
        String(value) === "." ||
        String(value) === ".." ||
        /[\\/\x00-\x1f]/.test(String(value))
      )
        throw new BadRequestException("路径参数无效");
      path = path.replace(`{${field.name}}`, encodeURIComponent(String(value)));
    } else if (field.in === "query") query.append(field.name, String(value));
  }
  if (/[{}]/.test(path)) throw new BadRequestException("接口路径参数不完整");
  if (
    input.file &&
    (operation.encoding !== "multipart/form-data" ||
      !operation.schema.properties?.[input.file.field] ||
      operation.schema.properties[input.file.field].format !== "binary")
  ) {
    throw new BadRequestException("接口未声明该上传文件字段");
  }
  await beforeRequest?.();
  return client.nativeRequest(`${path}${query.size ? `?${query}` : ""}`, {
    method: operation.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    body: input.body,
    encoding: operation.encoding,
    file: input.file,
  });
}
