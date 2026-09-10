const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guard before querying uuid columns — PostgreSQL rejects malformed uuids with an error. */
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
