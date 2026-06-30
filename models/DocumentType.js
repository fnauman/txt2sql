/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// DocumentType: synthetic sales document type master.
	const DocumentType = sequelize.define('DocumentType', {
		DocumentTypeId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the document type.'
		},
		DocumentTypeName: {
			type: DataTypes.STRING(80),
			allowNull: true,
			comment: 'Synthetic document type name such as Sales Invoice or Credit Memo.'
		},
		DocumentTypeClass: {
			type: DataTypes.STRING(40),
			allowNull: true,
			comment: 'Coarse document grouping used as a deliberate lower-signal column.'
		}
	}, {
		tableName: 'DocumentType',
		timestamps: false,
		freezeTableName: true
	});

	DocumentType.associate = (models) => {
		DocumentType.hasMany(models.SalesDocument, { foreignKey: 'DocumentTypeId', as: 'SalesDocuments' });
	};

	return DocumentType;
};
