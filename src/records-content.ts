/** Record-only tool text: no feedback, review or rechecking instructions. */
import { TOOLS as FULL_TOOLS } from "./content/tools.ts";
import { PARAMS as FULL_PARAMS } from "./content/params.ts";
export const TOOLS = {
  create_propositions: FULL_TOOLS.create_propositions,
  update_proposition: FULL_TOOLS.update_proposition,
  set_qualifier: FULL_TOOLS.set_qualifier,
  promote_warrant: FULL_TOOLS.promote_warrant,
  delete_proposition: FULL_TOOLS.delete_proposition,
  get_argument: { title: "Get argument", description: "Read a proposition's five slots, timestamps and referenced neighbours. Use this when you know its id; otherwise use find_propositions." },
  find_propositions: { title: "Find propositions", description: "Find proposition records by keyword or credence band, with pagination." },
  get_stats: { title: "Get stats", description: "Count stored propositions by credence band and count attachment references. These are record counts, not judgments about their contents." },
  get_history: { title: "Get history", description: "Read timestamped record changes and agent judgments, including revision notes and deleted records. Use get_argument for current contents." },
};
export const PARAMS = {
  ...FULL_PARAMS,
  warrant: FULL_PARAMS.warrant.replace("May be left empty while the proposition is still 'unestablished'; taking it to 'possibly' or above is when the structural check asks for it.", "May be left empty; the agent records the reasoning when available."),
  offset: "Number of records to skip (default 0).",
};
