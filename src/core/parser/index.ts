import idfc from '../../../templates/idfc.json';
import type { TemplateSet } from '../types';

export { parseSms, rawHash } from './engine';
export const bundledTemplates = idfc as TemplateSet;
