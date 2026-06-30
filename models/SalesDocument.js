/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// SalesDocument: synthetic sales document header for demo text-to-SQL workflows.
	const SalesDocument = sequelize.define('SalesDocument', {
		SalesDocumentId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the sales document header.'
		},
		DocumentNo: {
			type: DataTypes.STRING(30),
			allowNull: true,
			unique: true,
			comment: 'Synthetic document number.'
		},
		DocumentDate: {
			type: DataTypes.DATEONLY,
			allowNull: true,
			comment: 'Business date for the sales document.'
		},
		PostingDate: {
			type: DataTypes.DATEONLY,
			allowNull: true,
			comment: 'Accounting posting date for the sales document.'
		},
		DueDate: {
			type: DataTypes.DATEONLY,
			allowNull: true,
			comment: 'Payment due date for the sales document.'
		},
		CustomerId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'Customer', key: 'CustomerId' },
			comment: 'Customer associated with this document.'
		},
		StoreLocationId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'StoreLocation', key: 'StoreLocationId' },
			comment: 'Store or warehouse location for this document.'
		},
		DocumentTypeId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'DocumentType', key: 'DocumentTypeId' },
			comment: 'Document type for this sales document.'
		},
		CampaignId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'Campaign', key: 'CampaignId' },
			comment: 'Optional campaign directly associated with this document.'
		},
		IsCanceled: {
			type: DataTypes.INTEGER(1),
			allowNull: false,
			defaultValue: '0',
			comment: 'Flag indicating whether the document was canceled.'
		},
		GrossAmount: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Gross header amount before selected adjustments.'
		},
		NetAmount: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Preferred document-level net sales amount.'
		},
		NetPayableAmount: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Net payable amount; included as an intentionally distinct metric.'
		},
		PaidAmount: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Amount paid against this document.'
		},
		BalanceAmount: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Outstanding balance for this document.'
		},
		SubtotalAmount: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Subtotal header amount.'
		},
		BillTotalAmount: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Bill total header amount.'
		}
	}, {
		tableName: 'SalesDocument',
		timestamps: false,
		freezeTableName: true
	});

	SalesDocument.associate = (models) => {
		SalesDocument.belongsTo(models.Customer, { foreignKey: 'CustomerId', as: 'Customer' });
		SalesDocument.belongsTo(models.StoreLocation, { foreignKey: 'StoreLocationId', as: 'StoreLocation' });
		SalesDocument.belongsTo(models.DocumentType, { foreignKey: 'DocumentTypeId', as: 'DocumentType' });
		SalesDocument.belongsTo(models.Campaign, { foreignKey: 'CampaignId', as: 'Campaign' });
		SalesDocument.hasMany(models.SalesDocumentLine, { foreignKey: 'SalesDocumentId', as: 'SalesDocumentLines' });
		SalesDocument.hasMany(models.AccountingPosting, { foreignKey: 'SalesDocumentId', as: 'AccountingPostings' });
	};

	return SalesDocument;
};
