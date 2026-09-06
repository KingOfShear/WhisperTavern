content => {
  const usernameRegex = /\|用户：(.*?)\|/;

  const usernameMatches = content.match(usernameRegex);
  let username = '用户';
  if (usernameMatches && usernameMatches.length > 1) {
    username = usernameMatches[1];
  }

  content = content.replace(usernameRegex, '');

  // 匹配所有 <小猫之神世界书处理>...</小猫之神世界书处理> 的内容
  const regex = /<\|world_info\|>([\s\S]*?)<\/\|world_info\|>/g;

  // 先提取所有匹配内容
  const matches = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    matches.push(match[1]);
  }

  // 去掉原来的标签和内容
  const withoutTags = content.replace(regex, '');

  // 世界书内容哈希
  const hashContent = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + c;
      hash |= 0;
    }
    return 'w' + hash.toString(36);
  };

  // 按聊天独立缓存世界书hash
  const chatId = window.SillyTavern.getContext().chatId;
  if (!window.SPresetTempData.NekoGodC_worldBook) {
    window.SPresetTempData.NekoGodC_worldBook = {};
  }
  const cache = window.SPresetTempData.NekoGodC_worldBook[chatId] || {};
  const isFirstRun = Object.keys(cache).length === 0;

  const cachedEntries = [];
  const newEntries = [];
  const newCache = { ...cache };

  for (const entry of matches) {
    const h = hashContent(entry);
    if (isFirstRun || cache[h]) {
      cachedEntries.push(entry);
    } else {
      newEntries.push(entry);
    }
    newCache[h] = true;
  }

  window.SPresetTempData.NekoGodC_worldBook[chatId] = newCache;

  const cachedContent = cachedEntries.join('\n').trim();
  const newContent = newEntries.join('\n').trim();

  // 把提取的内容追加到相应位置
  let result = withoutTags
    .replaceAll(
      '<|前置世界书|>',
      cachedContent ? '\n\n<world_settings>\n' + cachedContent + '\n</world_settings>\n' : '',
    )
    .replaceAll(
      '|小猫之神_世界书|',
      newContent ? '\n\n<additional_info>\n' + newContent + '\n</additional_info>\n' : '',
    ).trim();

  // 清理残留空行
  result = result.replace(/\n{3,}/g, '\n\n');

  const deleteRegex = /\|delete\|[\s\S]*?\|\/delete\|/g;
  result = result.replace(deleteRegex, '');

  const syntaxRegex = /\n?<\|[\s\S]*?\|>/g;
  const syntaxMatches = result.match(syntaxRegex) || [];

  // 处理脚本语法
  for (const syntaxMatch of syntaxMatches) {
    const isNewLine = syntaxMatch.startsWith('\n');
    const syntax = syntaxMatch.substring(isNewLine ? 3 : 2, syntaxMatch.length - 2);
    const args = syntax.split(' ');
    switch (args[0]) {
      case '//':
        // 处理 // 语法
        result = result.replace(syntaxMatch, '');
        break;
      case 'set':
        try {
          if (!window.SPresetTempData.NekoGodC) {
            window.SPresetTempData.NekoGodC = {};
          }
          const varName = args[1];
          const varValue = args.slice(2).join(' ');
          window.SPresetTempData.NekoGodC[varName] = varValue;
          result = result.replace(syntaxMatch, '');
        } catch (e) {
          console.error('Error processing set syntax:', e);
        }
        break;
      case 'get':
        try {
          const varName = args[1];
          const value = window.SPresetTempData.NekoGodC ? window.SillyTavern.getContext().substituteParams(window.SPresetTempData.NekoGodC[varName]) : null;
          result = result.replace(syntaxMatch, value ? (isNewLine ? '\n' + value : value) : '');
        } catch (e) {
          console.error('Error processing get syntax:', e);
        }
        break;
      case 'if':
        try {
          let condition = args[1];
          let expected = 'true';
          let expectedBool = true;
          if (condition.startsWith('!')) {
            condition = condition.substring(1);
            expected = 'false';
            expectedBool = false;
          }
          condition = window.SPresetTempData.NekoGodC ? window.SPresetTempData.NekoGodC[condition] : null;
          const replaces = args.slice(2).join(' ').split('|else|');
          const replace = window.SillyTavern.getContext().substituteParams(replaces[0]);
          const elseReplace = replaces.length > 1 ? window.SillyTavern.getContext().substituteParams(replaces[1]) : '';
          if ((typeof condition === 'string' && condition === expected) || (typeof condition === 'boolean' && condition === expectedBool)) {
            result = result.replace(syntaxMatch, isNewLine ? '\n' + replace : replace);
          } else {
            result = result.replace(syntaxMatch, (elseReplace && isNewLine) ? '\n' + elseReplace : elseReplace);
          }
        } catch (e) {
          console.error('Error processing if syntax:', e);
        }
        break;
      case 'del':
        try {
          const varName = args[1];
          delete window.SPresetTempData.NekoGodC[varName];
          result = result.replace(syntaxMatch, '');
        } catch (e) {
          console.error('Error processing del syntax:', e);
        }
        break;
      case 'clear':
        try {
          window.SPresetTempData.NekoGodC = {};
          result = result.replace(syntaxMatch, '');
        } catch (e) {
          console.error('Error processing clear syntax:', e);
        }
        break;
      case 'eval':
        try {
          const expression = args.slice(1).join(' ');
          const evaluated = eval(expression);
          result = result.replace(syntaxMatch, isNewLine ? '\n' + evaluated : evaluated);
        } catch (e) {
          console.error('Error processing eval syntax:', e);
        }
        break;
      default:
        // 处理其他语法
        result = result.replace(syntaxMatch, '');
        break;
    }
  }

  let prev = null; // 'cat' | 'user' | null
  const re = /[\n]*\|(小猫之神|用户)\|/g;

  // 处理 summary 标签，插入剧情总结标记
  // 找到所有独立的 <summary>（前面没有 details）
  const summaryPositions = [];
  const summaryRegex = /<summary>/g;
  let summaryMatch;

  while ((summaryMatch = summaryRegex.exec(result)) !== null) {
    const index = summaryMatch.index;
    // 检查前面是否紧跟着 details>（排除 <details><summary> 的情况）
    const before = result.substring(Math.max(0, index - 10), index);
    if (!/details>\s*$/.test(before)) {
      summaryPositions.push(index);
    }
  }

  // 排除最后四个，只处理前面的
  const positionsToProcess = summaryPositions.slice(0, -3);

  // 从后往前处理，避免索引偏移问题
  for (let i = positionsToProcess.length - 1; i >= 0; i--) {
    const pos = positionsToProcess[i];
    const insertPos = pos + '<summary>'.length;
    const insertText = `\n---第${i + 1}段剧情总结---`;
    result = result.substring(0, insertPos) + insertText + result.substring(insertPos);
  }

  return String(result);
};