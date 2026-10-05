// Importers owned by importers-A: workplace exports, network files, surveys and
// the generic spreadsheet mapper. Order does not matter; the pipeline ranks by
// detect() score and hands each file to the best match.
import slack from './slack.js';
import teams from './teams.js';
import email from './email.js';
import calendar from './calendar.js';
import networkFiles from './network-files.js';
import networkCanvas from './network-canvas.js';
import survey from './survey.js';
import tabular from './tabular.js';
import sharedSurvey from './survey-response.js';

export default [slack, teams, email, calendar, networkFiles, networkCanvas, survey, sharedSurvey, tabular];
