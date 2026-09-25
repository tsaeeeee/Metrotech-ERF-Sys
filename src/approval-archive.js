import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

export function approvalArchivePath(request){
  return path.join(process.env.PDF_DIR||'/data/pdfs',String(request.id),'approved-archive',`r${Number(request.revision)}.pdf`);
}

export async function archiveApprovedPacket(request){
  if(!request.form_pdf_path)
    throw Object.assign(new Error('Approved PDF is unavailable. Recall was not applied.'),{status:409});
  const destination=approvalArchivePath(request);
  await fs.mkdir(path.dirname(destination),{recursive:true});
  try{
    await fs.copyFile(request.form_pdf_path,destination,constants.COPYFILE_EXCL);
  }catch(error){
    if(error.code==='ENOENT')
      throw Object.assign(new Error('Approved PDF is missing. Recall was not applied.'),{status:409});
    if(error.code!=='EEXIST') throw error;
    // A retry after a rolled-back transaction must never overwrite the archive.
    const [source,archived]=await Promise.all([fs.readFile(request.form_pdf_path),fs.readFile(destination)]);
    if(!source.equals(archived))
      throw Object.assign(new Error('Approved PDF archive differs from the current packet. Recall was not applied.'),{status:409});
  }
  return destination;
}
