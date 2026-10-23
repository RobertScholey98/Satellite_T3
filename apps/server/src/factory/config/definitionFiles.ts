import {
  FACTORY_CONFIG_FORMAT_VERSION,
  FactoryConfigSettings,
  FactoryDefinitionId,
  FactoryLeadDefinition,
  FactoryManagerDefinition,
  FactoryTeamDefinition,
  FactoryTeamMemberDefinition,
  FactoryWorkerDefinition,
  type FactoryConfigProblem,
  type FactoryModelList,
  type FactoryModelRef,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * The text form of the factory config. Files Satellite writes must re-encode to the same bytes, so
 * every encoder builds its frontmatter in a fixed key order, omits keys at their decoding default,
 * and writes LF endings with one trailing newline. Decoders accept hand edits: CRLF, a byte order
 * mark and a missing trailing newline.
 */

type Decoded<A> = Result.Result<A, FactoryConfigProblem>;

// No folding, so a long `useWhen` stays on one line, and no anchors, so shared objects never
// turn into `&a1`/`*a1` references.
const YAML_OPTIONS = { lineWidth: 0, aliasDuplicateObjects: false } as const;

const FRONTMATTER = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/;

const normalizeText = (text: string) => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const problem = (path: string, message: string): Decoded<never> => Result.fail({ path, message });

const firstLine = (text: string) => text.split("\n", 1)[0] ?? text;

const parseYamlRecord = (path: string, text: string): Decoded<Record<string, unknown>> => {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    return problem(
      path,
      `Not valid YAML: ${firstLine(cause instanceof Error ? cause.message : String(cause))}`,
    );
  }
  if (parsed === null || parsed === undefined) return Result.succeed({});
  return isRecord(parsed) ? Result.succeed(parsed) : problem(path, "Expected a YAML map.");
};

const parseMarkdown = (
  path: string,
  text: string,
): Decoded<{ readonly frontmatter: Record<string, unknown>; readonly body: string }> => {
  const normalized = normalizeText(text);
  const match = FRONTMATTER.exec(normalized);
  if (!match) return problem(path, "Expected YAML frontmatter between --- lines.");
  return Result.map(parseYamlRecord(path, match[1] ?? ""), (frontmatter) => ({
    frontmatter,
    body: normalized.slice(match[0].length),
  }));
};

const renderMarkdown = (frontmatter: Record<string, unknown>, body: string) => {
  const yaml = stringifyYaml(frontmatter, YAML_OPTIONS);
  const text = body.replace(/\r\n?/g, "\n").trim();
  return text.length === 0 ? `---\n${yaml}---\n` : `---\n${yaml}---\n\n${text}\n`;
};

const decodeWith = <S extends Schema.Decoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownResult(schema);
  return (path: string, input: unknown): Decoded<S["Type"]> => {
    const decoded = decode(input);
    return Result.isSuccess(decoded)
      ? Result.succeed(decoded.success)
      : problem(path, decoded.failure.message.replace(/\n\s*/g, " "));
  };
};

const isDefinitionId = Schema.is(FactoryDefinitionId);

const checkId = (path: string, id: string): Decoded<FactoryDefinitionId> =>
  isDefinitionId(id)
    ? Result.succeed(id)
    : problem(path, `"${id}" is not a valid id: use lowercase letters, digits and dashes.`);

const encodeModelRef = (ref: FactoryModelRef) => ({
  model: `${ref.driver}/${ref.model}`,
  ...(ref.options && ref.options.length > 0
    ? { options: Object.fromEntries(ref.options.map(({ id, value }) => [id, value])) }
    : {}),
});

const encodeModelRefs = (refs: ReadonlyArray<FactoryModelRef>) => refs.map(encodeModelRef);

const encodeModelList = (list: FactoryModelList) =>
  list.dynamic || list.models.length > 0
    ? {
        models: {
          ...(list.dynamic ? { dynamic: true } : {}),
          ...(list.models.length > 0 ? { list: encodeModelRefs(list.models) } : {}),
        },
      }
    : {};

/** Splits on the first slash: the model part may itself contain slashes. */
const parseModelRef = (path: string, entry: unknown): Decoded<unknown> => {
  if (!isRecord(entry) || typeof entry.model !== "string") {
    return problem(path, 'Each model entry needs "model: driver/model".');
  }
  const slash = entry.model.indexOf("/");
  if (slash <= 0 || slash === entry.model.length - 1) {
    return problem(path, `"${entry.model}" is not driver/model.`);
  }
  const ref = { driver: entry.model.slice(0, slash), model: entry.model.slice(slash + 1) };
  if (entry.options === undefined) return Result.succeed(ref);
  if (!isRecord(entry.options)) {
    return problem(path, `The options of "${entry.model}" must be a map of option to value.`);
  }
  return Result.succeed({
    ...ref,
    options: Object.entries(entry.options).map(([id, value]) => ({ id, value })),
  });
};

const parseModelRefs = (path: string, value: unknown, key: string): Decoded<unknown> => {
  if (value === undefined) return Result.succeed([]);
  if (!Array.isArray(value)) return problem(path, `"${key}" must be a list of models.`);
  return Result.all(value.map((entry) => parseModelRef(path, entry)));
};

const parseModelList = (path: string, value: unknown): Decoded<unknown> => {
  if (value === undefined || value === null) return Result.succeed({});
  if (!isRecord(value)) return problem(path, '"models" must be a map with "dynamic" and "list".');
  return Result.map(parseModelRefs(path, value.list, "models.list"), (models) => ({
    ...(value.dynamic === undefined ? {} : { dynamic: value.dynamic }),
    models,
  }));
};

export const FACTORY_SETTINGS_FILE = "factory.yaml";

export const DEFAULT_FACTORY_SETTINGS: FactoryConfigSettings = Schema.decodeSync(
  FactoryConfigSettings,
)({ version: FACTORY_CONFIG_FORMAT_VERSION });

export const encodeSettingsFile = (settings: FactoryConfigSettings): string =>
  stringifyYaml(
    {
      version: settings.version,
      ...(settings.modelPool.length > 0 ? { modelPool: encodeModelRefs(settings.modelPool) } : {}),
      ...(settings.recoveryAllowance === DEFAULT_FACTORY_SETTINGS.recoveryAllowance
        ? {}
        : { recoveryAllowance: settings.recoveryAllowance }),
    },
    YAML_OPTIONS,
  );

const decodeSettings = decodeWith(FactoryConfigSettings);

export const decodeSettingsFile = (path: string, text: string): Decoded<FactoryConfigSettings> =>
  Result.flatMap(parseYamlRecord(path, normalizeText(text)), (fields) =>
    Result.flatMap(parseModelRefs(path, fields.modelPool, "modelPool"), (modelPool) =>
      decodeSettings(path, { ...fields, modelPool }),
    ),
  );

export interface DefinitionFileInput {
  /** Relative to the factory config directory, with forward slashes. */
  readonly path: string;
  /** The file stem. */
  readonly id: string;
  readonly text: string;
}

const decodeDefinitionFile = <S extends Schema.Decoder<unknown>>(
  schema: S,
  bodyKey: "description" | "instructions",
  extraKeys: ReadonlyArray<string> = [],
) => {
  const decode = decodeWith(schema);
  return (input: DefinitionFileInput): Decoded<S["Type"]> =>
    Result.flatMap(checkId(input.path, input.id), (id) =>
      Result.flatMap(parseMarkdown(input.path, input.text), ({ frontmatter, body }) =>
        Result.flatMap(parseModelList(input.path, frontmatter.models), (models) =>
          decode(input.path, {
            ...Object.fromEntries(extraKeys.map((key) => [key, frontmatter[key]])),
            id,
            name: frontmatter.name,
            models,
            [bodyKey]: body,
          }),
        ),
      ),
    );
};

export const encodeWorkerFile = (definition: FactoryWorkerDefinition): string =>
  renderMarkdown(
    { name: definition.name, ...encodeModelList(definition.models) },
    definition.description,
  );

export const decodeWorkerFile = decodeDefinitionFile(FactoryWorkerDefinition, "description");

const encodeProtocolFile = (definition: FactoryLeadDefinition | FactoryManagerDefinition) =>
  renderMarkdown(
    { name: definition.name, ...encodeModelList(definition.models) },
    definition.instructions,
  );

export const encodeLeadFile: (definition: FactoryLeadDefinition) => string = encodeProtocolFile;
export const decodeLeadFile = decodeDefinitionFile(FactoryLeadDefinition, "instructions");

export const encodeManagerFile: (definition: FactoryManagerDefinition) => string =
  encodeProtocolFile;
export const decodeManagerFile = decodeDefinitionFile(FactoryManagerDefinition, "instructions");

export const TEAM_FILE = "team.md";
export const TEAM_LEAD_FILE = "lead.md";
export const TEAM_MEMBERS_DIRECTORY = "members";

interface TeamFile {
  /** Relative to the team folder, with forward slashes. */
  readonly path: string;
  readonly contents: string;
}

export const encodeTeamFiles = (team: FactoryTeamDefinition): ReadonlyArray<TeamFile> => [
  {
    path: TEAM_FILE,
    contents: renderMarkdown(
      {
        name: team.name,
        useWhen: team.useWhen,
        ...(team.mayEditProtectedPaths ? { mayEditProtectedPaths: true } : {}),
        ...(team.createdBy === "user" ? {} : { createdBy: team.createdBy }),
      },
      team.workflow,
    ),
  },
  {
    path: TEAM_LEAD_FILE,
    // The file stem is fixed, so the copy keeps the source lead's id in its frontmatter.
    contents: renderMarkdown(
      { id: team.lead.id, name: team.lead.name, ...encodeModelList(team.lead.models) },
      team.lead.instructions,
    ),
  },
  ...team.members.map((member) => ({
    path: `${TEAM_MEMBERS_DIRECTORY}/${member.id}.md`,
    contents: renderMarkdown(
      { name: member.name, count: member.count, ...encodeModelList(member.models) },
      member.description,
    ),
  })),
];

interface TeamFilesInput {
  /** The folder name. */
  readonly id: string;
  /** The team folder relative to the factory config directory, with forward slashes. */
  readonly directory: string;
  /** Null when the file is missing. */
  readonly team: string | null;
  readonly lead: string | null;
  readonly members: ReadonlyArray<{ readonly id: string; readonly text: string }>;
}

const decodeTeamLead = (path: string, text: string): Decoded<FactoryLeadDefinition> =>
  Result.flatMap(parseMarkdown(path, text), ({ frontmatter }) =>
    typeof frontmatter.id === "string"
      ? decodeLeadFile({ path, id: frontmatter.id, text })
      : problem(path, "The team's lead copy needs the source lead's id under \"id\"."),
  );

const decodeMember = decodeDefinitionFile(FactoryTeamMemberDefinition, "description", ["count"]);

const decodeTeam = decodeWith(FactoryTeamDefinition);

/**
 * A team loads whole or not at all: a bad `team.md` or `lead.md`, or no usable member, skips it.
 * A bad member file skips only that member. Members are matched by name when a lead delegates, so
 * a second member with a name already taken is skipped too.
 */
export const decodeTeamFiles = (
  input: TeamFilesInput,
): {
  readonly team: FactoryTeamDefinition | null;
  readonly problems: ReadonlyArray<FactoryConfigProblem>;
} => {
  const problems: FactoryConfigProblem[] = [];
  const teamPath = `${input.directory}/${TEAM_FILE}`;
  const leadPath = `${input.directory}/${TEAM_LEAD_FILE}`;
  const skip = (found: FactoryConfigProblem) => ({ team: null, problems: [...problems, found] });

  const members: FactoryTeamMemberDefinition[] = [];
  const names = new Set<string>();
  for (const file of [...input.members].toSorted((a, b) => a.id.localeCompare(b.id))) {
    const path = `${input.directory}/${TEAM_MEMBERS_DIRECTORY}/${file.id}.md`;
    const member = decodeMember({ path, id: file.id, text: file.text });
    if (Result.isFailure(member)) {
      problems.push(member.failure);
    } else if (names.has(member.success.name)) {
      problems.push({
        path,
        message: `Another member of this team is named "${member.success.name}"; a lead delegates by name.`,
      });
    } else {
      names.add(member.success.name);
      members.push(member.success);
    }
  }

  const id = checkId(input.directory, input.id);
  if (Result.isFailure(id)) return skip(id.failure);
  if (input.team === null) return skip({ path: teamPath, message: "The team has no team.md." });
  if (input.lead === null) return skip({ path: leadPath, message: "The team has no lead.md." });
  const header = parseMarkdown(teamPath, input.team);
  if (Result.isFailure(header)) return skip(header.failure);
  const lead = decodeTeamLead(leadPath, input.lead);
  if (Result.isFailure(lead)) return skip(lead.failure);
  if (members.length === 0) {
    return skip({ path: input.directory, message: "The team has no valid members." });
  }

  const { frontmatter, body } = header.success;
  const team = decodeTeam(teamPath, {
    id: id.success,
    name: frontmatter.name,
    useWhen: frontmatter.useWhen,
    workflow: body,
    mayEditProtectedPaths: frontmatter.mayEditProtectedPaths,
    createdBy: frontmatter.createdBy,
    lead: lead.success,
    members,
  });
  return Result.isFailure(team) ? skip(team.failure) : { team: team.success, problems };
};

const MAX_ID_LENGTH = 64;

const fitId = (base: string, suffix: string) =>
  `${base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;

/** The id a new definition gets from its name. It never changes after creation. */
export const definitionIdFromName = (name: string, taken: ReadonlySet<string>): string => {
  const base =
    fitId(
      name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
      "",
    ) || "definition";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = fitId(base, `-${n}`);
    if (!taken.has(candidate)) return candidate;
  }
};
