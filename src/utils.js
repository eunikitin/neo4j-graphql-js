export function parseArgs(args, variableValues) {
  // get args from selection.arguments object
  // or from resolveInfo.variableValues if arg is a variable
  // note that variable values override default values

  if (!args) {
    return {};
  }

  if (args.length === 0) {
    return {};
  }

  return args.reduce((acc, arg) => {
    switch (arg.value.kind) {
      case 'IntValue':
        acc[arg.name.value] = parseInt(arg.value.value);
        break;
      case 'FloatValue':
        acc[arg.name.value] = parseFloat(arg.value.value);
        break;
      case 'Variable':
        acc[arg.name.value] = variableValues[arg.name.value];
        break;
      default:
        acc[arg.name.value] = arg.value.value;
    }

    return acc;
  }, {});
}

function getDefaultArguments(fieldName, schemaType) {
  // get default arguments for this field from schema

  try {
    return schemaType._fields[fieldName].args.reduce((acc, arg) => {
      acc[arg.name] = arg.defaultValue;
      return acc;
    }, {});
  } catch (err) {
    return {};
  }
}

export function cypherDirectiveArgs(
  variable,
  headSelection,
  schemaType,
  resolveInfo
) {
  const defaultArgs = getDefaultArguments(headSelection.name.value, schemaType);
  const queryArgs = parseArgs(
    headSelection.arguments,
    resolveInfo.variableValues
  );

  let args = JSON.stringify(Object.assign(defaultArgs, queryArgs)).replace(
    /\"([^(\")"]+)\":/g,
    ' $1: '
  );

  return args === '{}'
    ? `{this: ${variable}${args.substring(1)}`
    : `{this: ${variable},${args.substring(1)}`;
}

export function isMutation(resolveInfo) {
  return resolveInfo.operation.operation === 'mutation';
}

export function isAddRelationshipMutation(resolveInfo) {
  return (
    resolveInfo.operation.operation === 'mutation' &&
    (resolveInfo.fieldName.startsWith('Add') ||
      resolveInfo.fieldName.startsWith('add')) &&
    resolveInfo.schema
      .getMutationType()
      .getFields()
      [resolveInfo.fieldName].astNode.directives.filter(x => {
        return x.name.value === 'MutationMeta';
      }).length > 0
  );
}

export function typeIdentifiers(returnType) {
  const typeName = innerType(returnType).toString();
  return {
    variableName: lowFirstLetter(typeName),
    typeName
  };
}

export function isGraphqlScalarType(type) {
  return (
    type.constructor.name === 'GraphQLScalarType' ||
    type.constructor.name === 'GraphQLEnumType'
  );
}

export function isArrayType(type) {
  return type.toString().startsWith('[');
}

export function lowFirstLetter(word) {
  return word.charAt(0).toLowerCase() + word.slice(1);
}

export function innerType(type) {
  return type.ofType ? innerType(type.ofType) : type;
}

// handles field level schema directives
// TODO: refactor to handle Query/Mutation type schema directives
const directiveWithArgs = (directiveName, args) => (schemaType, fieldName) => {
  function fieldDirective(schemaType, fieldName, directiveName) {
    const field = schemaType.getFields()[fieldName];

    return field.astNode && field.astNode.directives
      ? field.astNode.directives.find(e => e.name.value === directiveName)
      : null;
  }

  function directiveArgument(directive, name) {
    return directive.arguments.find(e => e.name.value === name).value.value;
  }

  const directive = fieldDirective(schemaType, fieldName, directiveName);
  const ret = {};
  if (directive) {
    Object.assign(
      ret,
      ...args.map(key => ({
        [key]: directiveArgument(directive, key)
      }))
    );
  }
  return ret;
};

export const cypherDirective = directiveWithArgs('cypher', ['statement']);
export const relationDirective = directiveWithArgs('relation', [
  'name',
  'direction'
]);

export function innerFilterParams(selections) {
  let queryParams = '';

  if (
    selections &&
    selections.length &&
    selections[0].arguments &&
    selections[0].arguments.length
  ) {
    const filters = selections[0].arguments
      .filter(x => {
        return x.name.value !== 'first' && x.name.value !== 'offset';
      })
      .map(x => {
        const filterValue = JSON.stringify(x.value.value).replace(
          /\"([^(\")"]+)\":/g,
          '$1:'
        ); // FIXME: support IN for multiple values -> WHERE
        return `${x.name.value}: ${filterValue}`;
      });

    queryParams = `{${filters.join(',')}}`;
  }
  return queryParams;
}

function argumentValue(selection, name, variableValues) {
  let arg = selection.arguments.find(a => a.name.value === name);
  if (!arg) {
    return null;
  } else if (
    !arg.value.value &&
    name in variableValues &&
    arg.value.kind === 'Variable'
  ) {
    return variableValues[name];
  } else {
    return arg.value.value;
  }
}

export function extractQueryResult({ records }, returnType) {
  const { variableName } = typeIdentifiers(returnType);

  return isArrayType(returnType)
    ? records.map(record => record.get(variableName))
    : records.length
      ? records[0].get(variableName)
      : null;
}

export function computeSkipLimit(selection, variableValues) {
  let first = argumentValue(selection, 'first', variableValues);
  let offset = argumentValue(selection, 'offset', variableValues);

  if (first === null && offset === null) return '';
  if (offset === null) return `[..${first}]`;
  if (first === null) return `[${offset}..]`;
  return `[${offset}..${parseInt(offset) + parseInt(first)}]`;
}

export function extractSelections(selections, fragments) {
  // extract any fragment selection sets into a single array of selections
  return selections.reduce((acc, cur) => {
    if (cur.kind === 'FragmentSpread') {
      return [...acc, ...fragments[cur.name.value].selectionSet.selections];
    } else {
      return [...acc, cur];
    }
  }, []);
}

export function fixParamsForAddRelationshipMutation(params, resolveInfo) {
  // FIXME: find a better way to map param name in schema to datamodel
  let mutationMeta, fromTypeArg, toTypeArg;

  try {
    mutationMeta = resolveInfo.schema
      .getMutationType()
      .getFields()
      [resolveInfo.fieldName].astNode.directives.filter(x => {
        return x.name.value === 'MutationMeta';
      })[0];
  } catch (e) {
    throw new Error(
      'Missing required MutationMeta directive on add relationship directive'
    );
  }

  try {
    fromTypeArg = mutationMeta.arguments.filter(x => {
      return x.name.value === 'from';
    })[0];

    toTypeArg = mutationMeta.arguments.filter(x => {
      return x.name.value === 'to';
    })[0];
  } catch (e) {
    throw new Error(
      'Missing required argument in MutationMeta directive (relationship, from, or to)'
    );
  }
  //TODO: need to handle one-to-one and one-to-many

  const fromType = fromTypeArg.value.value,
    toType = toTypeArg.value.value,
    fromVar = lowFirstLetter(fromType),
    toVar = lowFirstLetter(toType),
    fromParam = resolveInfo.schema
      .getMutationType()
      .getFields()
      [resolveInfo.fieldName].astNode.arguments[0].name.value.substr(
        fromVar.length
      ),
    toParam = resolveInfo.schema
      .getMutationType()
      .getFields()
      [resolveInfo.fieldName].astNode.arguments[1].name.value.substr(
        toVar.length
      );

  params[toParam] =
    params[
      resolveInfo.schema.getMutationType().getFields()[
        resolveInfo.fieldName
      ].astNode.arguments[1].name.value
    ];

  params[fromParam] =
    params[
      resolveInfo.schema.getMutationType().getFields()[
        resolveInfo.fieldName
      ].astNode.arguments[0].name.value
    ];

  delete params[
    resolveInfo.schema.getMutationType().getFields()[resolveInfo.fieldName]
      .astNode.arguments[1].name.value
  ];

  delete params[
    resolveInfo.schema.getMutationType().getFields()[resolveInfo.fieldName]
      .astNode.arguments[0].name.value
  ];

  console.log(params);

  return params;
}
