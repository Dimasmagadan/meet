#!/usr/bin/env node
import { createProgram, handleActionError } from "./cli.js";

// P2-7 (SPEC_SAFETY_NET_2026-10-31 §5.3): all CLI actions are async, and
// plain .parse() does not await them — an expected error (missing session,
// failed setup check) used to surface as a raw unhandled-rejection stack.
// parseAsync routes it to one red line instead. CommanderError re-throws so
// --help/--version exit codes stay intact.
createProgram().parseAsync(process.argv).catch(handleActionError);
