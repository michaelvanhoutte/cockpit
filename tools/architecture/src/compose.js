/**
 * The drawing file and the rules file, joined. `tools/architecture/description.yml` says how the design is drawn (where
 * each box sits, how a store or an outside service is found in the code); `docs/architecture.yml` says what the design
 * is (the layers and their parts, what each may call, what is not allowed, the accepted deviations, who reaches it).
 * The two name the same ids: one in the rules and not the drawing, or the reverse, fails the run and names it.
 *
 * The result is the shape `parseDesign` reads, so the rest of the tool is as it was. Pure.
 */

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const sorted = (set) => [...set].sort();
const missingFrom = (a, b) => sorted(a).filter((each) => !b.has(each));

/** A client box of the drawing that is no part of the rules: a caller, found by its name in `reached by`. */
const isCaller = (chip) => chip?.caller !== undefined;

/**
 * Cockpit's design: the drawing's layers and chips, named and sized by the rules' parts, with the rules' calls, `not
 * allowed` sentences, accepted deviations and callers.
 */
function composeCockpit(design, section, fail) {
  const ruleLayers = new Map(section.layers.map((layer) => [layer.id, layer]));
  const drawn = list(design.layers).filter(isObject);
  const drawnIds = new Set(drawn.map((layer) => layer.id));

  const notDrawn = missingFrom(new Set(ruleLayers.keys()), drawnIds);
  if (notDrawn.length > 0) fail(`the rules file has the layer ${notDrawn[0]}, which design.layers does not place`);
  const notRuled = missingFrom(drawnIds, new Set(ruleLayers.keys()));
  if (notRuled.length > 0) fail(`design.layers has the layer ${notRuled[0]}, which the rules file does not have`);

  const layers = drawn.map((layer) => {
    const rule = ruleLayers.get(layer.id);
    const parts = new Map(rule.parts.map((part) => [part.id, part]));
    const items = list(layer.items).map((row) => list(row).map((chip) => {
      if (!isObject(chip) || isCaller(chip)) return chip;
      const part = parts.get(chip.id);
      if (!part) fail(`design layer ${layer.id} has the chip ${chip.id}, which the rules file has no part for`);
      const own = chip;
      const kind = own.kind ?? (part.store ? 'store' : layer.kind === 'outside' ? 'outside' : undefined);
      // A client or an outside service is not a folder of the code, whatever the rules say it is made of.
      const folders = (kind === undefined || kind === 'component' || kind === 'store') && part.code.length > 0 && own.in === undefined ? part.code : undefined;
      return { name: part.name, ...(part.what ? { sub: part.what } : {}), ...(folders ? { folders } : {}), ...own, ...(kind ? { kind } : {}) };
    }));
    const chipIds = new Set(items.flat().filter((chip) => isObject(chip) && !isCaller(chip)).map((chip) => chip.id));
    const noChip = missingFrom(new Set(parts.keys()), chipIds);
    if (noChip.length > 0) fail(`the rules file has the part ${noChip[0]} in the layer ${layer.id}, which design.layers has no chip for`);
    return { ...layer, title: rule.name, items };
  });

  const mayCall = {};
  const breaks = {};
  const reasons = {};
  for (const layer of section.layers) {
    if (layer.calls.length > 0) mayCall[layer.id] = layer.calls;
    for (const to of layer.calls) reasons[`${layer.id}>${to}`] = layer.callNotes[to];
    for (const [to, sentence] of Object.entries(layer.notAllowed)) breaks[`${layer.id}>${to}`] = sentence;
  }

  // Each caller the rules say reaches Cockpit has one in the drawing, found by the same name.
  const drawnCallers = list(design.callers).filter(isObject);
  const names = new Set(section.reachedBy.map((each) => each.caller));
  for (const each of drawnCallers) if (!names.has(each.caller)) fail(`design.callers has the caller ${each.caller ?? each.from}, which \`reached by\` in the rules file does not have`);
  const callers = section.reachedBy.map((reach) => {
    const found = drawnCallers.find((each) => each.caller === reach.caller);
    if (!found) fail(`the rules file says ${reach.caller} reaches it, and design.callers has no caller of that name`);
    return { from: found.from, to: reach.at, how: reach.how, ...(found.code ? { code: found.code } : {}) };
  });

  return { ...design, layers, mayCall, breaks, reasons, rules: section.rules, accepted: section.accepted, knownBreaches: section.knownBreaches, callers };
}

/**
 * A service the rules do not rule inside. What its rules section keeps is how it is reached and what it may call; its
 * layers and parts are the drawing's alone. With `calls`, the layer of kind `service` may call exactly those and nothing
 * else is ruled; without, every line between its layers is allowed (`unruled`), so it is drawn by its boundary.
 */
function composeService(id, design, section, fail) {
  const layers = list(design.layers).filter(isObject);
  const layerIds = new Set(layers.map((layer) => layer.id));
  let mayCall = {};
  const reasons = {};
  let unruled = true;
  if (section.calls !== null) {
    const own = layers.filter((layer) => layer.kind === 'service');
    if (own.length !== 1) fail(`${id}: the rules file gives it \`calls\`, and design.layers needs exactly one layer of kind service to make them`);
    const noLayer = section.calls.filter((to) => !layerIds.has(to));
    if (noLayer.length > 0) fail(`the rules file says ${id} calls ${noLayer[0]}, which design.layers does not place`);
    const notCalled = layers.filter((layer) => layer !== own[0] && !section.calls.includes(layer.id));
    if (notCalled.length > 0) fail(`design.layers places ${notCalled[0].id}, which the rules file does not say ${id} calls`);
    mayCall = { [own[0].id]: section.calls };
    for (const to of section.calls) reasons[`${own[0].id}>${to}`] = section.callNotes[to];
    unruled = false;
  }

  let callers = design.callers;
  if (section.reachedBy.length > 0) {
    const drawnCallers = list(design.callers).filter(isObject);
    const names = new Set(section.reachedBy.map((each) => each.caller));
    for (const each of drawnCallers) if (!names.has(each.caller)) fail(`${id}: design.callers has the caller ${each.caller ?? each.from}, which \`reached by\` in the rules file does not have`);
    const layerOf = new Map(layers.flatMap((layer) => list(layer.items).flat().map((chip) => [chip.id, layer.id])));
    callers = section.reachedBy.map((reach) => {
      const found = drawnCallers.find((each) => each.caller === reach.caller);
      if (!found) fail(`the rules file says ${reach.caller} reaches ${id}, and its design.callers has no caller of that name`);
      if (layerOf.get(found.to) !== reach.at) fail(`the rules file says ${reach.caller} reaches ${id} at ${reach.at}, and the drawing draws it at ${found.to}`);
      return { from: found.from, to: found.to, how: reach.how, ...(found.code ? { code: found.code } : {}) };
    });
  }
  return { ...design, mayCall, breaks: {}, reasons, rules: section.rules, accepted: section.accepted, callers, unruled };
}

/** The `owns` folders of the services page come from the rules' `code`; the packages stay with the drawing. */
function composeServiceMap(map, rules, fail) {
  if (!isObject(map)) return map;
  const ruled = new Set(Object.keys(rules.services));
  if (ruled.size > 0) {
    const drawn = new Set(list(map.services).filter(isObject).map((each) => each.id));
    const noBox = missingFrom(ruled, drawn);
    if (noBox.length > 0) fail(`the rules file has the service ${noBox[0]}, which serviceMap.services does not draw`);
    const noRule = missingFrom(drawn, ruled);
    if (noRule.length > 0) fail(`serviceMap.services draws ${noRule[0]}, which the rules file does not have as a service`);

    // A call from one service to another is a rule of the file, and the reverse.
    const calls = list(map.calls).filter((call) => isObject(call) && ruled.has(call.from) && ruled.has(call.to)).map((call) => `${call.from}>${call.to}`);
    const between = rules.between.filter((each) => each.from && each.to).map((each) => `${each.from}>${each.to}`);
    const unruledCall = calls.find((each) => !between.includes(each));
    if (unruledCall) fail(`serviceMap.calls draws ${unruledCall.replace('>', ' to ')}, which \`between services\` in the rules file does not allow`);
    const undrawn = between.find((each) => !calls.includes(each));
    if (undrawn) fail(`\`between services\` in the rules file allows ${undrawn.replace('>', ' to ')}, which serviceMap.calls does not draw`);
  }
  const owns = {};
  for (const [id, own] of Object.entries(isObject(map.owns) ? map.owns : {})) {
    if (isObject(own) && own.folders !== undefined) fail(`serviceMap.owns.${id}.folders belongs in the rules file, as the service's \`code\``);
    const code = rules.services[id]?.code;
    owns[id] = { ...(isObject(own) ? own : {}), ...(code ? { folders: code } : {}) };
  }
  return { ...map, owns, between: rules.between };
}

/**
 * @param {object} value the drawing file, parsed
 * @param {object|null} rules the rules file, parsed (`parseRules`)
 * @param {(reason: string) => never} fail
 * @returns {object} the same value, its `design`, `otherServices` and `serviceMap.owns` completed from the rules
 */
export function composeDescription(value, rules, fail, rulesFile) {
  const needsRules = isObject(value.design) || list(value.otherServices).length > 0 || isObject(value.serviceMap);
  if (!needsRules) return value;
  if (!rules) fail(`the rules file ${rulesFile} was not given, and the drawing is composed from it`);

  const out = { ...value };
  if (isObject(value.design)) {
    const section = rules.sections.cockpit;
    if (!section?.layers) fail('the rules file has no `cockpit` section with layers');
    out.design = composeCockpit(value.design, section, fail);
  }

  out.otherServices = list(value.otherServices).map((service) => {
    if (!isObject(service) || !isObject(service.design)) return service;
    const section = rules.sections[service.id];
    if (!section) fail(`the rules file has no section for the service ${service.id}`);
    const name = service.name ?? rules.services[service.id]?.name;
    return { ...service, ...(name ? { name } : {}), design: composeService(service.id, service.design, section, fail) };
  });
  if (value.otherServices === undefined) delete out.otherServices;

  if (isObject(value.serviceMap)) out.serviceMap = composeServiceMap(value.serviceMap, rules, fail);

  // The sources the drawing finds in the code are the ones the rules file knows.
  const known = rules.sections.cockpit?.sources ?? [];
  if (known.length > 0) {
    const found = new Set(list(value.sources).filter(isObject).map((each) => each.id));
    const noWords = missingFrom(new Set(known), found);
    if (noWords.length > 0) fail(`the rules file has the source ${noWords[0]}, which \`sources\` does not find in the code`);
    const noSource = missingFrom(found, new Set(known));
    if (noSource.length > 0) fail(`\`sources\` finds ${noSource[0]} in the code, which the rules file does not have as a source`);
  }
  return out;
}
