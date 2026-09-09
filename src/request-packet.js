import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';

const execFileAsync=promisify(execFile);
const MB=1024*1024;
const targetMb=Math.max(0.25,Number(process.env.FINAL_PDF_TARGET_MB||1));
const maxMb=Math.max(Number(process.env.FINAL_PDF_MAX_MB||2),targetMb);
const TARGET_BYTES=targetMb*MB;
const MAX_BYTES=maxMb*MB;

const compressionProfiles=[
  {dpi:150,jpeg:82},
  {dpi:120,jpeg:78},
  {dpi:100,jpeg:74},
  {dpi:84,jpeg:68},
  {dpi:72,jpeg:60},
  {dpi:60,jpeg:52}
];

async function exists(filePath){
  if(!filePath) return false;
  try{await fs.access(filePath);return true}catch{return false}
}

async function fileSize(filePath){
  return Number((await fs.stat(filePath)).size||0);
}

async function copyPdfPages(target,sourcePath){
  if(!await exists(sourcePath)) return 0;
  const bytes=await fs.readFile(sourcePath);
  const source=await PDFDocument.load(bytes);
  const pages=await target.copyPages(source,source.getPageIndices());
  pages.forEach(page=>target.addPage(page));
  return pages.length;
}

async function runGhostscript(inputPath,outputPath,{dpi,jpeg}){
  const args=[
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    '-dSAFER',
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    '-dAutoFilterColorImages=false',
    '-dAutoFilterGrayImages=false',
    '-dColorImageFilter=/DCTEncode',
    '-dGrayImageFilter=/DCTEncode',
    '-dDownsampleColorImages=true',
    '-dDownsampleGrayImages=true',
    '-dDownsampleMonoImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    '-dGrayImageDownsampleType=/Bicubic',
    '-dMonoImageDownsampleType=/Subsample',
    `-dColorImageResolution=${dpi}`,
    `-dGrayImageResolution=${dpi}`,
    `-dMonoImageResolution=${Math.max(120,dpi*2)}`,
    `-dJPEGQ=${jpeg}`,
    `-sOutputFile=${outputPath}`,
    inputPath
  ];
  await execFileAsync('gs',args,{maxBuffer:4*1024*1024});
}

async function replaceFile(source,target){
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.rm(target,{force:true});
  await fs.rename(source,target);
}

export async function optimizePdf({inputPath,outPath}){
  const originalBytes=await fileSize(inputPath);
  if(originalBytes<=TARGET_BYTES){
    await replaceFile(inputPath,outPath);
    return {path:outPath,size:originalBytes,compressed:false,targetMet:true};
  }

  const candidates=[];
  try{
    for(let i=0;i<compressionProfiles.length;i++){
      const profile=compressionProfiles[i];
      const candidate=`${outPath}.compress-${i}.tmp.pdf`;
      await fs.rm(candidate,{force:true});
      await runGhostscript(inputPath,candidate,profile);
      const size=await fileSize(candidate);
      candidates.push({path:candidate,size,profile});
      if(size<=TARGET_BYTES){
        await replaceFile(candidate,outPath);
        return {path:outPath,size,compressed:true,targetMet:true,profile};
      }
    }

    const withinCap=candidates
      .filter(x=>x.size<=MAX_BYTES)
      .sort((a,b)=>a.size-b.size)[0];
    if(withinCap){
      await replaceFile(withinCap.path,outPath);
      return {path:outPath,size:withinCap.size,compressed:true,targetMet:false,profile:withinCap.profile};
    }

    const smallest=candidates.sort((a,b)=>a.size-b.size)[0];
    const actual=smallest?.size||originalBytes;
    throw new Error(
      `Final request packet could not be reduced below ${maxMb.toFixed(0)} MB `+
      `(smallest ${(actual/MB).toFixed(2)} MB). Reduce the number or resolution of evidence files.`
    );
  }finally{
    await Promise.all(candidates.map(async x=>{
      if(x.path!==outPath) await fs.rm(x.path,{force:true}).catch(()=>{});
    }));
    await fs.rm(inputPath,{force:true}).catch(()=>{});
  }
}

export async function buildRequestPacket({formPath,evidencePath,outPath}){
  if(!await exists(formPath)) throw new Error('Request form PDF is unavailable.');
  await fs.mkdir(path.dirname(outPath),{recursive:true});

  const rawPath=`${outPath}.raw.tmp.pdf`;
  await fs.rm(rawPath,{force:true});

  const packet=await PDFDocument.create();
  const formPages=await copyPdfPages(packet,formPath);
  if(!formPages) throw new Error('Request form PDF contains no pages.');
  const evidencePages=await copyPdfPages(packet,evidencePath);

  await fs.writeFile(rawPath,await packet.save({useObjectStreams:true}));
  const result=await optimizePdf({inputPath:rawPath,outPath});
  return {...result,formPages,evidencePages};
}
