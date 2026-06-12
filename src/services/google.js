import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Creates authenticated Google Auth client using Service Account key.
 * @returns {google.auth.GoogleAuth}
 */
const getGoogleAuth = () => {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Google Service Account JSON key not found at ${path.resolve(keyPath)}. Ensure the file exists.`);
  }

  return new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets'
    ]
  });
};

/**
 * Uploads an audio clip file to the configured Google Drive folder.
 * @param {string} filePath - Local path of the WAV file.
 * @param {string} filename - Target filename on Google Drive (e.g. frequence_000001.wav).
 * @returns {Promise<{fileId: string, webViewLink: string}>}
 */
export const uploadAudioToDrive = async (filePath, filename) => {
  const auth = getGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });
  
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  
  const fileMetadata = {
    name: filename,
    parents: folderId && folderId !== 'replace_with_drive_folder_id' ? [folderId] : []
  };

  const media = {
    mimeType: 'audio/wav',
    body: fs.createReadStream(filePath)
  };

  try {
    console.log(`Uploading ${filename} to Google Drive folder: ${folderId || 'Root'}`);
    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, webViewLink'
    });

    return {
      fileId: response.data.id,
      webViewLink: response.data.webViewLink
    };
  } catch (error) {
    console.error('Google Drive Upload Error:', error);
    throw new Error(`Failed to upload audio to Google Drive: ${error.message}`);
  }
};

/**
 * Fetches the latest numbering value (ID) from Column A of the Google Sheet.
 * @returns {Promise<number>} - The last numeric ID found, or 0.
 */
export const getLastIdFromSheet = async () => {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  if (!spreadsheetId || spreadsheetId === 'replace_with_sheet_id') {
    console.warn('Google Sheet ID not configured in .env, returning last ID as 0');
    return 0;
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'A:A'
    });

    const rows = response.data.values;
    if (!rows || rows.length <= 1) {
      return 0; // Only header or empty sheet
    }

    // Iterate backwards to find the last numeric ID
    for (let i = rows.length - 1; i >= 1; i--) {
      const val = rows[i][0];
      if (val) {
        const idNum = parseInt(val, 10);
        if (!isNaN(idNum)) {
          return idNum;
        }
      }
    }
    return 0;
  } catch (error) {
    console.error('Failed to get last ID from Google Sheet:', error);
    return 0;
  }
};

/**
 * Appends a row of transcription data to the configured Google Sheet.
 * Row format: [ID, File Name, Source URL, Start Time, End Time, Duration, Transcription, Annotator, Upload Date, Quality Flags, Quality Reason]
 * @param {Array<string|number>} rowValues - Column values.
 * @returns {Promise<void>}
 */
export const appendRowToSheet = async (rowValues) => {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  if (!spreadsheetId || spreadsheetId === 'replace_with_sheet_id') {
    console.warn('Google Sheet ID not configured in .env, skipping sheet update');
    return;
  }

  // Format ID to 6 digit padded string for output if it's a number
  if (typeof rowValues[0] === 'number') {
    rowValues[0] = String(rowValues[0]).padStart(6, '0');
  }

  try {
    console.log(`Appending transcription row for ID ${rowValues[0]} to Sheet: ${spreadsheetId}`);
    
    // First, verify/create header if sheet is completely empty
    const checkResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'A1:A1'
    });
    
    if (!checkResponse.data.values || checkResponse.data.values.length === 0) {
      // Initialize headers
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'A1:K1',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            'ID',
            'File Name',
            'Source URL',
            'Start Time',
            'End Time',
            'Duration',
            'Transcription',
            'Annotator',
            'Upload Date',
            'Quality Flags',
            'Quality Reason'
          ]]
        }
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'A:K',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [rowValues]
      }
    });
  } catch (error) {
    console.error('Google Sheets Append Error:', error);
    throw new Error(`Failed to append row to Google Sheet: ${error.message}`);
  }
};
