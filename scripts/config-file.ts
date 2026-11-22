import { parse } from "yaml";
import { parseConfig, type Config } from "../src/config";

export function parseWatchersYaml(text: string): Config {
  return parseConfig(parse(text));
}
