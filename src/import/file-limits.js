// What a file picked for upload must look like before it is read (CLAUDE.md section 3, A04: size, type and format are checked at the boundary).
// The size matches the file bucket's own limit (supabase/004_assets_limits.sql), so the page refuses early what the server would refuse anyway.
const CSV_MAX_BYTES = 10 * 1024 * 1024;
const CSV_NAME = /\.csv$/i;

/**
 * Why a file cannot be used as the Fundamental CSV, or '' when it can.
 * @param {{ name?: string, size?: number }} file
 * @returns {string} a user-safe sentence
 */
function csvFileProblem(file){
  if(!file || typeof file.name !== 'string' || !CSV_NAME.test(file.name)) return 'Choose a .csv file (the Screener.in export).';
  if(typeof file.size !== 'number' || !(file.size >= 0)) return 'This file looks unreadable. Please choose it again.';
  if(file.size === 0) return 'This file is empty.';
  if(file.size > CSV_MAX_BYTES) return 'This file is larger than ' + (CSV_MAX_BYTES / 1048576) + ' MB, which is more than a stock export should be.';
  return '';
}

export { csvFileProblem };
